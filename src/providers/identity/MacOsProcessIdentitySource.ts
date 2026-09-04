import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { clearTimeout as cancelTimer, setTimeout as startTimer } from "node:timers";
import { ProcessExecutionError, SafeProcessRunner } from "../../cmux/SafeProcessRunner";
import { isCanonicalUuid } from "../../security/identifiers";
import { resolveProviderDataRoot } from "../providerDataRoot";
import { readBoundedUtf8File } from "../readBoundedFile";
import { sanitizeProviderTitle } from "../titleSanitizer";
import type {
  ClaudeProcessSession,
  LocalProcessIdentitySource,
  ProviderProcess
} from "./types";

const PROCESS_LIST_COMMAND = [
  "-axo",
  "pid=,ppid=,pgid=,tpgid=,state=,lstart=,comm="
] as const;
const PROCESS_TIMEOUT_MS = 3_000;
const PROCESS_LIST_LIMIT = 2 * 1024 * 1024;
const DIAGNOSTIC_LIMIT = 64 * 1024;
const REGISTRY_FILE_LIMIT = 64 * 1024;
const FORCE_KILL_AFTER_MS = 250;

export class MacOsProcessIdentitySource implements LocalProcessIdentitySource {
  private readonly cancelPipelineByChild = new Map<ChildProcess, () => void>();
  private readonly claudeRoot: string;
  private readonly codexHome: string;
  private disposed = false;

  constructor(
    private readonly runner = new SafeProcessRunner(),
    private readonly userHome = homedir(),
    private readonly isProcessLive: (pid: number) => boolean = processIsLive
  ) {
    this.claudeRoot = resolveProviderDataRoot(
      process.env.CLAUDE_CONFIG_DIR,
      path.join(this.userHome, ".claude")
    );
    this.codexHome = resolveProviderDataRoot(
      process.env.CODEX_HOME,
      path.join(this.userHome, ".codex")
    );
  }

  async listForegroundProviderProcesses(signal?: AbortSignal): Promise<ProviderProcess[]> {
    const result = await this.runner.run("/bin/ps", PROCESS_LIST_COMMAND, {
      timeoutMs: PROCESS_TIMEOUT_MS,
      maxStdoutBytes: PROCESS_LIST_LIMIT,
      maxStderrBytes: DIAGNOSTIC_LIMIT,
      signal,
      environment: localIdentityEnvironment({ LC_ALL: "C", TZ: "UTC" })
    });
    return decodeProviderProcesses(result.stdout).filter(
      (candidate) =>
        candidate.foregroundProcessGroupId > 0 &&
        candidate.processGroupId === candidate.foregroundProcessGroupId
    );
  }

  async readSurfaceId(pid: number, signal?: AbortSignal): Promise<string | null> {
    assertPid(pid);
    if (this.disposed || signal?.aborted) return null;
    return this.readSurfaceIdPipeline(pid, signal);
  }

  async readClaudeSession(
    processRecord: ProviderProcess,
    cwd: string,
    signal?: AbortSignal
  ): Promise<ClaudeProcessSession | null> {
    assertPid(processRecord.pid);
    if (processRecord.provider !== "claude") return null;
    if (!path.isAbsolute(cwd) || cwd.includes("\0")) return null;
    if (this.disposed) return null;
    const filename = path.join(this.claudeRoot, "sessions", `${processRecord.pid}.json`);
    try {
      const snapshot = await readBoundedUtf8File(filename, REGISTRY_FILE_LIMIT, signal);
      if (!snapshot || this.disposed) return null;
      const session = decodeClaudeProcessSession(
        JSON.parse(snapshot.content) as unknown,
        processRecord,
        cwd
      );
      if (session === null || !this.isProcessLive(processRecord.pid) || this.disposed) return null;
      return session;
    } catch (error) {
      if (isAbort(error)) throw error;
      return null;
    }
  }

  async readCodexWriterSessionIds(pid: number, signal?: AbortSignal): Promise<string[]> {
    assertPid(pid);
    const lockDirectory = path.join(this.codexHome, "thread-writer-locks");
    try {
      const result = await this.runner.run(
        "/usr/sbin/lsof",
        ["-nP", "-a", "-p", String(pid), "+d", lockDirectory, "-Fn"],
        {
          timeoutMs: PROCESS_TIMEOUT_MS,
          maxStdoutBytes: DIAGNOSTIC_LIMIT,
          maxStderrBytes: DIAGNOSTIC_LIMIT,
          signal,
          environment: localIdentityEnvironment({ LC_ALL: "C" })
        }
      );
      return decodeWriterLockSessionIds(result.stdout, lockDirectory);
    } catch (error) {
      if (
        error instanceof ProcessExecutionError &&
        error.reason === "exit" &&
        error.exitCode === 1
      ) {
        return decodeWriterLockSessionIds(error.stdout, lockDirectory);
      }
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.runner.dispose();
    for (const cancel of new Set(this.cancelPipelineByChild.values())) cancel();
    this.cancelPipelineByChild.clear();
  }

  private readSurfaceIdPipeline(pid: number, signal?: AbortSignal): Promise<string | null> {
    return new Promise((resolve) => {
      const ps = spawn("/bin/ps", ["eww", "-p", String(pid), "-o", "command="], {
        env: localIdentityEnvironment({ LC_ALL: "C" }),
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      });
      const grep = spawn(
        "/usr/bin/grep",
        ["-Eo", "CMUX_SURFACE_ID=[0-9A-Fa-f-]{36}"],
        {
          env: localIdentityEnvironment({ LC_ALL: "C" }),
          shell: false,
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true
        }
      );
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let timer: ReturnType<typeof startTimer> | null = null;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) cancelTimer(timer);
        signal?.removeEventListener("abort", abort);
        if (ps.stdout && grep.stdin) ps.stdout.unpipe(grep.stdin);
        ps.stdout?.destroy();
        grep.stdin?.destroy();
        grep.stdout?.destroy();
        terminateOwnedChild(ps);
        terminateOwnedChild(grep);
        this.cancelPipelineByChild.delete(ps);
        this.cancelPipelineByChild.delete(grep);
        resolve(value);
      };
      const abort = (): void => finish(null);
      const cancel = (): void => finish(null);
      timer = startTimer(() => finish(null), PROCESS_TIMEOUT_MS);
      this.cancelPipelineByChild.set(ps, cancel);
      this.cancelPipelineByChild.set(grep, cancel);
      if (signal?.aborted) {
        finish(null);
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      grep.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 4_096) {
          finish(null);
          return;
        }
        chunks.push(chunk);
      });
      ps.stdout?.once("error", () => finish(null));
      grep.stdin?.once("error", () => finish(null));
      ps.once("error", () => finish(null));
      grep.once("error", () => finish(null));
      ps.stdout?.pipe(grep.stdin);
      grep.once("close", () => {
        const ids = new Set(
          Buffer.concat(chunks)
            .toString("utf8")
            .split(/\r?\n/)
            .map((line) => line.replace(/^CMUX_SURFACE_ID=/, "").trim().toUpperCase())
            .filter(isCanonicalUuid)
        );
        finish(ids.size === 1 ? [...ids][0]! : null);
      });
    });
  }
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function decodeProviderProcesses(text: string): ProviderProcess[] {
  const all = new Map<number, ProviderProcess>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/
    );
    if (!match) continue;
    const executable = match[7]!;
    const provider = providerFromExecutable(executable);
    if (!provider) continue;
    const processRecord: ProviderProcess = {
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      processGroupId: Number(match[3]),
      foregroundProcessGroupId: Number(match[4]),
      state: match[5]!,
      startedAt: normalizeTimestamp(match[6]!),
      executable,
      provider
    };
    if (
      Number.isSafeInteger(processRecord.pid) &&
      processRecord.pid > 0 &&
      Number.isSafeInteger(processRecord.parentPid)
    ) {
      all.set(processRecord.pid, processRecord);
    }
  }
  return [...all.values()];
}

export function decodeClaudeProcessSession(
  value: unknown,
  expectedProcess: ProviderProcess,
  expectedCwd: string
): ClaudeProcessSession | null {
  const raw = record(value);
  if (
    !raw ||
    raw.pid !== expectedProcess.pid ||
    normalizeTimestamp(raw.procStart) !== expectedProcess.startedAt ||
    raw.cwd !== expectedCwd ||
    typeof raw.sessionId !== "string" ||
    !isCanonicalUuid(raw.sessionId)
  ) {
    return null;
  }
  return {
    sessionId: raw.sessionId,
    cwd: expectedCwd,
    status: sanitizeProviderTitle(raw.status)
  };
}

export function decodeWriterLockSessionIds(text: string, lockDirectory: string): string[] {
  const ids = new Set<string>();
  const prefix = `${lockDirectory}${path.sep}`;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("n")) continue;
    const filename = line.slice(1);
    if (!filename.startsWith(prefix) || !filename.endsWith(".lock")) continue;
    const id = path.basename(filename, ".lock");
    if (isCanonicalUuid(id)) ids.add(id);
  }
  return [...ids];
}

function providerFromExecutable(executable: string): ProviderProcess["provider"] | null {
  const basename = path.basename(executable);
  if (basename === "codex") return "codex";
  if (basename === "claude") return "claude";
  return null;
}

function normalizeTimestamp(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function assertPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Provider process PID is invalid.");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function localIdentityEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("CMUX_"))
    ),
    ...overrides
  };
}

function terminateOwnedChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = startTimer(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, FORCE_KILL_AFTER_MS);
  timer.unref();
}
