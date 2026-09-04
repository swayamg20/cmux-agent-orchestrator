import { cmuxCommands } from "./commandBuilders";
import {
  decodeCapabilities,
  decodeAgents,
  decodeFocusedTarget,
  decodeNotifications,
  decodeTree,
  decodeWorkspaceDirectories
} from "./decoders";
import { ProcessExecutionError, SafeProcessRunner } from "./SafeProcessRunner";
import { PRODUCT_NAME } from "../identity";
import type { CmuxTransport, PreviewRequest } from "./CmuxTransport";
import {
  CmuxError,
  type CmuxAgentRecord,
  type CmuxNotification,
  type CmuxPreview,
  type CmuxProbe,
  type CmuxSnapshot,
  type CmuxTarget
} from "./types";

const DEFAULT_TIMEOUT_MS = 3_000;
const JSON_OUTPUT_LIMIT = 512 * 1024;
const STDERR_LIMIT = 64 * 1024;
const READ_SCREEN_RAW_LIMIT = 96 * 1024;
const DIRECTORY_REFRESH_MS = 30_000;
const REQUIRED_METHODS = [
  "system.tree",
  "workspace.list",
  "surface.read_text",
  "surface.focus",
  "system.identify",
  "notification.list"
] as const;

export class CliCmuxTransport implements CmuxTransport {
  private workspaceDirectories = new Map<string, string | null>();
  private directoryRefreshGeneration = 0;
  private nextDirectoryRefreshAt = 0;

  constructor(
    private readonly binaryPath: string,
    private readonly runner = new SafeProcessRunner(),
    private readonly now: () => number = Date.now
  ) {}

  async probe(signal?: AbortSignal): Promise<CmuxProbe> {
    const startedAt = this.now();
    const version = await this.run(cmuxCommands.version(), 32 * 1024, signal);
    if (!/^cmux\s+\d+\.\d+\.\d+/m.test(version.stdout.trim())) {
      throw new CmuxError("binary-invalid", "The configured executable did not identify itself as cmux.");
    }
    const capabilityResult = await this.run(cmuxCommands.capabilities(), JSON_OUTPUT_LIMIT, signal);
    const capabilities = decodeCapabilities(capabilityResult.stdout);
    if (capabilities.protocol !== "cmux-socket") {
      throw new CmuxError("unsupported", `Unsupported cmux protocol: ${capabilities.protocol}`);
    }
    const missingMethods = REQUIRED_METHODS.filter((method) => !capabilities.methods.has(method));
    if (missingMethods.length > 0) {
      throw new CmuxError(
        "unsupported",
        `This cmux build is missing required capabilities: ${missingMethods.join(", ")}.`
      );
    }
    return {
      binaryPath: this.binaryPath,
      versionText: version.stdout.trim(),
      capabilities,
      latencyMs: this.now() - startedAt
    };
  }

  async snapshot(signal?: AbortSignal): Promise<CmuxSnapshot> {
    const observedAt = this.now();
    const shouldRefreshDirectories = observedAt >= this.nextDirectoryRefreshAt;
    const directoryRefreshGeneration = shouldRefreshDirectories
      ? ++this.directoryRefreshGeneration
      : null;
    const [tree, workspaceList] = await Promise.all([
      this.run(cmuxCommands.tree(), JSON_OUTPUT_LIMIT, signal),
      shouldRefreshDirectories
        ? this.run(cmuxCommands.listWorkspaces(), JSON_OUTPUT_LIMIT, signal)
        : Promise.resolve(null)
    ]);
    let directories = this.workspaceDirectories;
    if (workspaceList !== null) {
      directories = decodeWorkspaceDirectories(workspaceList.stdout);
      if (directoryRefreshGeneration === this.directoryRefreshGeneration) {
        this.workspaceDirectories = directories;
        this.nextDirectoryRefreshAt = observedAt + DIRECTORY_REFRESH_MS;
      }
    }
    return decodeTree(tree.stdout, observedAt, directories);
  }

  async notifications(signal?: AbortSignal): Promise<CmuxNotification[]> {
    const result = await this.run(cmuxCommands.listNotifications(), JSON_OUTPUT_LIMIT, signal);
    return decodeNotifications(result.stdout);
  }

  async agents(signal?: AbortSignal): Promise<CmuxAgentRecord[] | null> {
    try {
      const result = await this.run(cmuxCommands.listAgents(), JSON_OUTPUT_LIMIT, signal);
      return decodeAgents(result.stdout);
    } catch (error) {
      if (isUnsupportedListAgents(error)) return null;
      throw error;
    }
  }

  async readPreview(target: CmuxTarget, request: PreviewRequest): Promise<CmuxPreview> {
    const result = await this.run(
      cmuxCommands.readScreen(target, request.lines),
      READ_SCREEN_RAW_LIMIT,
      request.signal
    );
    const bounded = truncateUtf8(result.stdout, Math.max(1, request.maxBytes));
    return {
      workspaceId: target.workspaceId,
      surfaceId: target.surfaceId,
      text: bounded.text,
      observedAt: this.now(),
      truncated: bounded.truncated
    };
  }

  async focusedTarget(signal?: AbortSignal): Promise<CmuxTarget | null> {
    const result = await this.run(cmuxCommands.identifyFocused(), JSON_OUTPUT_LIMIT, signal);
    return decodeFocusedTarget(result.stdout);
  }

  async focus(target: CmuxTarget, signal?: AbortSignal): Promise<void> {
    await this.run(cmuxCommands.focusPanel(target), 32 * 1024, signal);
  }

  dispose(): void {
    this.runner.dispose();
  }

  private async run(args: readonly string[], maxStdoutBytes: number, signal?: AbortSignal) {
    try {
      return await this.runner.run(this.binaryPath, args, {
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxStdoutBytes,
        maxStderrBytes: STDERR_LIMIT,
        signal
      });
    } catch (error) {
      if (error instanceof CmuxError) throw error;
      if (!(error instanceof ProcessExecutionError)) {
        throw new CmuxError("process-failed", "cmux command failed unexpectedly.", error);
      }
      const message = `${error.stderr}\n${error.stdout}`.toLowerCase();
      if (error.reason === "timeout") {
        throw new CmuxError("timeout", "cmux did not respond before the timeout.", error);
      }
      if (error.reason === "output-limit") {
        throw new CmuxError("output-limit", `cmux returned more data than ${PRODUCT_NAME} allows.`, error);
      }
      if (error.reason === "aborted") {
        throw new CmuxError("aborted", "cmux request was cancelled.", error);
      }
      if (
        message.includes("authentication required") ||
        message.includes("authentication failed") ||
        message.includes("invalid password") ||
        message.includes("password required")
      ) {
        throw new CmuxError(
          "access-blocked",
          "cmux Password mode requires a valid Socket Password saved in cmux Settings before external clients can connect.",
          error
        );
      }
      if (
        message.includes("broken pipe") ||
        message.includes("failed to write to socket") ||
        message.includes("access denied") ||
        message.includes("not allowed") ||
        message.includes("unauthorized")
      ) {
        throw new CmuxError(
          "access-blocked",
          "cmux rejected this normally launched client. Complete the one-time Socket Control Mode setup in cmux Settings.",
          error
        );
      }
      if (
        message.includes("connection refused") ||
        message.includes("no such file") ||
        message.includes("could not connect") ||
        message.includes("not running")
      ) {
        throw new CmuxError("cmux-not-running", "cmux is not running or its socket is unavailable.", error);
      }
      throw new CmuxError("process-failed", error.stderr.trim() || error.message, error);
    }
  }
}

function isUnsupportedListAgents(error: unknown): boolean {
  if (!(error instanceof CmuxError) || !(error.originalError instanceof ProcessExecutionError)) {
    return false;
  }
  const output = `${error.originalError.stderr}\n${error.originalError.stdout}`.toLowerCase();
  return output.includes("unknown command: list-agents") || output.includes("unknown command 'list-agents'");
}

export function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  let text = bytes.subarray(0, maxBytes).toString("utf8");
  if (text.endsWith("\uFFFD")) text = text.slice(0, -1);
  return { text, truncated: true };
}
