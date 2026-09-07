import { cmuxCommands } from "./commandBuilders";
import {
  decodeCapabilities,
  decodeAgents,
  decodeFocusedTarget,
  decodeNotifications,
  decodeSessionAgents,
  decodeTree,
  decodeWorkspaceDirectories
} from "./decoders";
import { ProcessExecutionError, SafeProcessRunner } from "./SafeProcessRunner";
import type { ProcessLineStream } from "./SafeProcessRunner";
import { clearTimeout as cancelTimer, setTimeout as startTimer } from "node:timers";
import { PRODUCT_NAME } from "../identity";
import type { CmuxEventObserver, CmuxTransport, PreviewRequest } from "./CmuxTransport";
import { CmuxEventCursor } from "./CmuxEventCursor";
import {
  CmuxError,
  type CmuxAgentRecord,
  type CmuxNotification,
  type CmuxPreview,
  type CmuxProbe,
  type CmuxSnapshot,
  type CmuxTarget
} from "./types";

const DEFAULT_TIMEOUT_MS = 5_000;
const JSON_OUTPUT_LIMIT = 512 * 1024;
const STDERR_LIMIT = 64 * 1024;
const READ_SCREEN_RAW_LIMIT = 96 * 1024;
const DIRECTORY_REFRESH_MS = 30_000;
const EVENT_STREAM_STARTUP_TIMEOUT_MS = 5_000;
const EVENT_STREAM_LINE_LIMIT = 64 * 1024;
const EVENT_STREAM_MISSED_HEARTBEATS = 3;
const REQUIRED_METHODS = [
  "system.tree",
  "workspace.list",
  "surface.read_text",
  "surface.focus",
  "system.identify",
  "notification.list"
] as const;

export interface CmuxEventTimerHandle {
  unref(): void;
}

export interface CmuxEventTimerScheduler {
  set(callback: () => void, delayMs: number): CmuxEventTimerHandle;
  clear(handle: CmuxEventTimerHandle): void;
}

const nodeEventTimers: CmuxEventTimerScheduler = {
  set: (callback, delayMs) => startTimer(callback, delayMs),
  clear: (handle) => cancelTimer(handle as ReturnType<typeof setTimeout>)
};

export class CliCmuxTransport implements CmuxTransport {
  private workspaceDirectories = new Map<string, string | null>();
  private directoryRefreshGeneration = 0;
  private nextDirectoryRefreshAt = 0;
  private eventsSupported = false;
  private stopEventStream: (() => void) | null = null;

  constructor(
    private readonly binaryPath: string,
    private readonly runner = new SafeProcessRunner(),
    private readonly now: () => number = Date.now,
    private readonly eventTimers: CmuxEventTimerScheduler = nodeEventTimers
  ) {}

  async probe(signal?: AbortSignal): Promise<CmuxProbe> {
    this.eventsSupported = false;
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
    this.eventsSupported =
      capabilities.methods.has("events.stream") || (await this.probeEventsCommand(signal));
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
      if (!isUnsupportedCommand(error, "list-agents")) throw error;
    }
    try {
      const result = await this.run(cmuxCommands.sessions(), JSON_OUTPUT_LIMIT, signal);
      return decodeSessionAgents(result.stdout);
    } catch (error) {
      if (isUnsupportedCommand(error, "sessions")) return null;
      throw error;
    }
  }

  subscribeEvents(observer: CmuxEventObserver): (() => void) | null {
    if (!this.eventsSupported) return null;
    this.stopEventStream?.();
    const cursor = new CmuxEventCursor();
    let active = true;
    let ready = false;
    let heartbeatIntervalSeconds: number | null = null;
    let idleTimer: CmuxEventTimerHandle | null = null;
    let stream: ProcessLineStream | null = null;
    const clearIdleTimer = (): void => {
      if (idleTimer === null) return;
      this.eventTimers.clear(idleTimer);
      idleTimer = null;
    };
    const stop = (): void => {
      if (!active) return;
      active = false;
      clearIdleTimer();
      stream?.dispose();
      if (this.stopEventStream === stop) this.stopEventStream = null;
    };
    const fail = (error: unknown): void => {
      if (!active) return;
      stop();
      observer.onError(eventStreamError(error));
    };
    const armIdleTimer = (): void => {
      if (heartbeatIntervalSeconds === null) return;
      clearIdleTimer();
      const timeoutMs = heartbeatIntervalSeconds * EVENT_STREAM_MISSED_HEARTBEATS * 1_000;
      idleTimer = this.eventTimers.set(() => {
        fail(
          new CmuxError(
            "timeout",
            "cmux event streaming stopped producing frames before its heartbeat deadline."
          )
        );
      }, timeoutMs);
      idleTimer.unref();
    };
    stream = this.runner.streamLines(
      this.binaryPath,
      cmuxCommands.events(),
      {
        startupTimeoutMs: EVENT_STREAM_STARTUP_TIMEOUT_MS,
        maxLineBytes: EVENT_STREAM_LINE_LIMIT,
        maxStderrBytes: STDERR_LIMIT
      },
      {
        onLine: (line) => {
          if (!active) return;
          try {
            const update = cursor.accept(line);
            if (update.frameType === "ack") {
              heartbeatIntervalSeconds = update.heartbeatIntervalSeconds;
              armIdleTimer();
              if (!ready) {
                ready = true;
                observer.onReady();
              }
            } else {
              armIdleTimer();
            }
            if (update.signal !== null) observer.onSignal(update.signal);
          } catch (error) {
            fail(error);
          }
        },
        onError: (error) => fail(error)
      }
    );
    if (!active) {
      stream.dispose();
      return null;
    }
    this.stopEventStream = stop;
    return stop;
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
      paneId: target.paneId,
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
    this.stopEventStream?.();
    this.stopEventStream = null;
    this.runner.dispose();
  }

  private async probeEventsCommand(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.run(cmuxCommands.eventsHelp(), 32 * 1024, signal);
      return true;
    } catch (error) {
      if (isUnsupportedCommand(error, "events")) return false;
      if (error instanceof CmuxError && error.code === "aborted") throw error;
      return false;
    }
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

function eventStreamError(error: unknown): CmuxError {
  if (error instanceof CmuxError) return error;
  if (error instanceof ProcessExecutionError) {
    if (error.originalError instanceof CmuxError) return error.originalError;
    if (error.reason === "timeout") {
      return new CmuxError("timeout", "cmux did not start its event stream before the timeout.", error);
    }
    if (error.reason === "output-limit") {
      return new CmuxError("output-limit", `cmux event data exceeded ${PRODUCT_NAME}'s safety limit.`, error);
    }
    if (error.reason === "aborted") {
      return new CmuxError("aborted", "cmux event streaming was cancelled.", error);
    }
    return new CmuxError(
      "process-failed",
      error.stderr.trim() || "cmux event streaming stopped unexpectedly.",
      error
    );
  }
  return new CmuxError("process-failed", "cmux event streaming failed unexpectedly.", error);
}

function isUnsupportedCommand(error: unknown, command: string): boolean {
  if (!(error instanceof CmuxError) || !(error.originalError instanceof ProcessExecutionError)) {
    return false;
  }
  const output = `${error.originalError.stderr}\n${error.originalError.stdout}`.toLowerCase();
  const normalizedCommand = command.toLowerCase();
  return (
    output.includes(`unknown command: ${normalizedCommand}`) ||
    output.includes(`unknown command '${normalizedCommand}'`) ||
    output.includes(`unknown command "${normalizedCommand}"`) ||
    output.includes(`unrecognized command '${normalizedCommand}'`) ||
    output.includes(`unrecognized command "${normalizedCommand}"`)
  );
}

export function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  let text = bytes.subarray(0, maxBytes).toString("utf8");
  if (text.endsWith("\uFFFD")) text = text.slice(0, -1);
  return { text, truncated: true };
}
