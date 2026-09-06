import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { clearTimeout as cancelTimer, setTimeout as startTimer } from "node:timers";
import path from "node:path";
import { isCanonicalUuid } from "../security/identifiers";
import { sanitizeProviderTitle } from "./titleSanitizer";
import {
  ProviderMetadataError,
  type ProviderSessionMetadata,
  type ProviderSessionSource
} from "./types";

const CODEX_CANDIDATES = [
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex"
] as const;
const APP_SERVER_TIMEOUT_MS = 5_000;
const APP_SERVER_STDOUT_LIMIT = 512 * 1024;
const APP_SERVER_STDERR_LIMIT = 64 * 1024;
const FORCE_KILL_AFTER_MS = 250;
const THREAD_LIST_LIMIT = 50;

export interface CodexAppServerRequester {
  request(method: "thread/list" | "thread/read", params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  dispose(): void;
}

class CodexRpcError extends ProviderMetadataError {
  constructor(public readonly code: number | null, message: string) {
    super(message);
    this.name = "CodexRpcError";
  }
}

export class CodexAppServerSource implements ProviderSessionSource {
  readonly provider = "codex" as const;

  constructor(private readonly requester: CodexAppServerRequester = new CodexAppServerClient()) {}

  async list(cwd: string, signal?: AbortSignal): Promise<ProviderSessionMetadata[]> {
    assertAbsoluteCwd(cwd);
    let response: unknown;
    try {
      response = await this.requester.request(
        "thread/list",
        { cwd, limit: THREAD_LIST_LIMIT, useStateDbOnly: true },
        signal
      );
    } catch (error) {
      if (!(error instanceof CodexRpcError) || error.code !== -32602) throw error;
      response = await this.requester.request("thread/list", { cwd, limit: THREAD_LIST_LIMIT }, signal);
    }
    return decodeCodexThreadList(response, cwd);
  }

  async get(sessionId: string, cwd: string, signal?: AbortSignal): Promise<ProviderSessionMetadata | null> {
    assertProviderSessionId(sessionId);
    assertAbsoluteCwd(cwd);
    const response = await this.requester.request(
      "thread/read",
      { threadId: sessionId, includeTurns: false },
      signal
    );
    const raw = record(response)?.thread;
    return decodeCodexThread(raw, cwd);
  }

  dispose(): void {
    this.requester.dispose();
  }
}

export class CodexAppServerClient implements CodexAppServerRequester {
  private readonly activeExchanges = new Map<
    ChildProcessWithoutNullStreams,
    (error: Error) => void
  >();
  private binaryDiscovery: Promise<string> | null = null;
  private disposed = false;

  constructor(private readonly discoverBinary: () => Promise<string> = discoverCodexBinary) {}

  async request(
    method: "thread/list" | "thread/read",
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.disposed) throw new ProviderMetadataError("Codex metadata access has been disposed.");
    if (signal?.aborted) throw new ProviderMetadataError("Codex metadata request was cancelled.");
    const binaryPath = await this.resolveBinary();
    if (this.disposed) throw new ProviderMetadataError("Codex metadata access has been disposed.");
    if (signal?.aborted) throw new ProviderMetadataError("Codex metadata request was cancelled.");
    return this.exchange(binaryPath, method, params, signal);
  }

  private async resolveBinary(): Promise<string> {
    const discovery = this.binaryDiscovery ??= this.discoverBinary();
    try {
      return await discovery;
    } finally {
      if (this.binaryDiscovery === discovery) this.binaryDiscovery = null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cancel of this.activeExchanges.values()) {
      cancel(new ProviderMetadataError("Codex metadata access has been disposed."));
    }
  }

  private exchange(
    binaryPath: string,
    method: "thread/list" | "thread/read",
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(binaryPath, [...codexAppServerCommand()], {
        env: codexMetadataEnvironment(process.env),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });

      const decoder = new StringDecoder("utf8");
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let lineBuffer = "";
      let settled = false;
      let timer: ReturnType<typeof startTimer> | null = null;

      const finish = (error: Error | null, result?: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) cancelTimer(timer);
        signal?.removeEventListener("abort", abort);
        terminateOwnedChild(child);
        destroyOwnedPipes(child);
        if (error) reject(error);
        else resolve(result);
      };
      const abort = (): void => finish(new ProviderMetadataError("Codex metadata request was cancelled."));
      this.activeExchanges.set(child, finish);
      timer = startTimer(
        () => finish(new ProviderMetadataError("Codex app-server did not respond before the timeout.")),
        APP_SERVER_TIMEOUT_MS
      );
      if (signal?.aborted) finish(new ProviderMetadataError("Codex metadata request was cancelled."));
      else signal?.addEventListener("abort", abort, { once: true });

      const send = (message: Record<string, unknown>): void => {
        if (settled) return;
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };

      const handleLine = (line: string): void => {
        if (!line.trim()) return;
        let message: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          const value = record(parsed);
          if (!value) throw new Error("Expected a JSON object.");
          message = value;
        } catch (error) {
          finish(new ProviderMetadataError("Codex app-server returned malformed JSON.", error));
          return;
        }
        if (message.id === 1) {
          if (message.error) {
            finish(decodeRpcError(message.error, "Codex app-server initialization failed."));
            return;
          }
          send({ method: "initialized", params: {} });
          send({ id: 2, method, params });
          return;
        }
        if (message.id !== 2) return;
        if (message.error) {
          finish(decodeRpcError(message.error, `Codex ${method} is unavailable.`));
          return;
        }
        finish(null, message.result);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > APP_SERVER_STDOUT_LIMIT) {
          finish(new ProviderMetadataError("Codex app-server metadata exceeded the bounded output limit."));
          return;
        }
        lineBuffer += decoder.write(chunk);
        let newline = lineBuffer.indexOf("\n");
        while (newline >= 0 && !settled) {
          const line = lineBuffer.slice(0, newline);
          lineBuffer = lineBuffer.slice(newline + 1);
          handleLine(line);
          newline = lineBuffer.indexOf("\n");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > APP_SERVER_STDERR_LIMIT) {
          finish(new ProviderMetadataError("Codex app-server diagnostics exceeded the bounded output limit."));
          return;
        }
      });
      child.stdout.once("error", (error) => {
        finish(new ProviderMetadataError("Could not read Codex app-server metadata.", error));
      });
      child.stderr.once("error", (error) => {
        finish(new ProviderMetadataError("Could not read Codex app-server diagnostics.", error));
      });
      child.stdin.once("error", (error) => {
        finish(new ProviderMetadataError("Could not write the bounded metadata request to Codex app-server.", error));
      });
      child.once("error", (error) => {
        finish(new ProviderMetadataError("Could not start the Codex app-server metadata source.", error));
      });
      child.once("close", (code) => {
        this.activeExchanges.delete(child);
        if (settled) return;
        finish(
          new ProviderMetadataError(
            `Codex app-server exited before returning metadata (code ${String(code)}).`
          )
        );
      });

      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "cmux_agent_orchestrator",
            title: "cmux Agent Orchestrator",
            version: "1"
          },
          capabilities: {
            optOutNotificationMethods: ["thread/started", "thread/status/changed", "turn/started", "turn/completed"]
          }
        }
      });
    });
  }
}

export function codexAppServerCommand(): readonly string[] {
  return ["app-server", "--listen", "stdio://"];
}

export async function discoverCodexBinary(): Promise<string> {
  for (const candidate of CODEX_CANDIDATES) {
    try {
      await access(candidate, constants.X_OK);
      const details = await stat(candidate);
      if (!details.isFile() || path.basename(candidate) !== "codex") continue;
      return await realpath(candidate);
    } catch {
      // Continue through the fixed executable allowlist.
    }
  }
  throw new ProviderMetadataError("Codex is not installed in a supported local path.");
}

export function decodeCodexThreadList(value: unknown, cwd: string): ProviderSessionMetadata[] {
  const data = record(value)?.data;
  if (!Array.isArray(data)) throw new ProviderMetadataError("Codex thread/list returned malformed metadata.");
  const sessions: ProviderSessionMetadata[] = [];
  const seen = new Set<string>();
  for (const candidate of data.slice(0, THREAD_LIST_LIMIT)) {
    const decoded = decodeCodexThread(candidate, cwd);
    if (decoded && !seen.has(decoded.sessionId)) {
      seen.add(decoded.sessionId);
      sessions.push(decoded);
    }
  }
  return sessions.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

export function decodeCodexThread(value: unknown, cwd: string): ProviderSessionMetadata | null {
  const raw = record(value);
  if (!raw || typeof raw.id !== "string" || !isCanonicalUuid(raw.id) || raw.cwd !== cwd) return null;
  const explicitName = sanitizeProviderTitle(raw.name);
  const preview = sanitizeProviderTitle(raw.preview);
  const fallback = `Codex conversation ${raw.id.slice(0, 8)}`;
  const status = record(raw.status)?.type;
  const parentSessionId =
    raw.parentThreadId === null
      ? null
      : typeof raw.parentThreadId === "string" && isCanonicalUuid(raw.parentThreadId)
        ? raw.parentThreadId
        : undefined;
  return {
    provider: "codex",
    sessionId: raw.id,
    title: explicitName ?? preview ?? fallback,
    titleSource: explicitName ? "explicit-name" : preview ? "provider-preview" : "session-id",
    cwd,
    updatedAt:
      typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
        ? Math.max(0, raw.updatedAt * 1_000)
        : null,
    status: sanitizeProviderTitle(status),
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    sourceKind: decodeCodexSourceKind(raw.source)
  };
}

function decodeCodexSourceKind(value: unknown): string | null {
  if (typeof value === "string") return sanitizeProviderTitle(value);
  const source = record(value);
  if (!source) return null;
  if (source.subAgent !== undefined) return "subAgent";
  if (source.custom !== undefined) return "custom";
  const keys = Object.keys(source);
  return keys.length === 1 ? sanitizeProviderTitle(keys[0]) : null;
}

function decodeRpcError(value: unknown, fallback: string): CodexRpcError {
  const error = record(value);
  const code = typeof error?.code === "number" ? error.code : null;
  const message = sanitizeProviderTitle(error?.message) ?? fallback;
  return new CodexRpcError(code, message);
}

function assertAbsoluteCwd(cwd: string): void {
  if (!path.isAbsolute(cwd) || cwd.includes("\0") || cwd.length > 4_096) {
    throw new ProviderMetadataError("Provider metadata requires a bounded absolute working directory.");
  }
}

function assertProviderSessionId(sessionId: string): void {
  if (!isCanonicalUuid(sessionId)) {
    throw new ProviderMetadataError("Provider conversation ID is not a canonical UUID.");
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function codexMetadataEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith("CMUX_"))
  );
}

function terminateOwnedChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = startTimer(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, FORCE_KILL_AFTER_MS);
  timer.unref();
}

function destroyOwnedPipes(child: ChildProcessWithoutNullStreams): void {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}
