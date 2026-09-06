import { spawn, type ChildProcess } from "node:child_process";
import { clearTimeout as cancelTimer, setTimeout as startTimer } from "node:timers";

const FORCE_KILL_AFTER_MS = 250;

function isRunning(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

export type ProcessFailureReason = "aborted" | "exit" | "output-limit" | "spawn" | "timeout";

export class ProcessExecutionError extends Error {
  constructor(
    public readonly reason: ProcessFailureReason,
    message: string,
    public readonly exitCode: number | null,
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = "ProcessExecutionError";
  }
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface ProcessRunOptions {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
  environment?: NodeJS.ProcessEnv;
}

export interface ProcessLineStreamOptions {
  startupTimeoutMs: number;
  maxLineBytes: number;
  maxStderrBytes: number;
  environment?: NodeJS.ProcessEnv;
}

export interface ProcessLineStreamHandlers {
  onLine(line: string): void;
  onError(error: ProcessExecutionError): void;
}

export interface ProcessLineStream {
  dispose(): void;
}

export class SafeProcessRunner {
  private readonly terminateByChild = new Map<ChildProcess, () => void>();
  private disposed = false;

  async run(
    executable: string,
    args: readonly string[],
    options: ProcessRunOptions
  ): Promise<ProcessResult> {
    if (this.disposed) {
      throw new ProcessExecutionError("aborted", "Process runner has been disposed.", null, "", "");
    }
    if (options.signal?.aborted) {
      throw new ProcessExecutionError("aborted", "Process was aborted before launch.", null, "", "");
    }

    return new Promise<ProcessResult>((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn(executable, [...args], {
        env: options.environment ?? process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const output = (chunks: readonly Buffer[]): string => Buffer.concat(chunks).toString("utf8");
      const releaseRequest = (): void => {
        if (timer !== null) {
          cancelTimer(timer);
          timer = null;
        }
        options.signal?.removeEventListener("abort", abort);
      };
      const releaseChild = (): void => {
        if (forceKillTimer !== null) {
          cancelTimer(forceKillTimer);
          forceKillTimer = null;
        }
        this.terminateByChild.delete(child);
      };
      const stopChild = (): void => {
        if (!isRunning(child)) return;
        child.kill("SIGTERM");
        forceKillTimer ??= startTimer(() => {
          if (isRunning(child)) child.kill("SIGKILL");
        }, FORCE_KILL_AFTER_MS);
        forceKillTimer.unref();
      };
      const fail = (reason: ProcessFailureReason): void => {
        if (settled) return;
        settled = true;
        releaseRequest();
        stopChild();
        child.stdout?.destroy();
        child.stderr?.destroy();
        const descriptions: Record<ProcessFailureReason, string> = {
          aborted: "Process was aborted.",
          exit: "Process failed.",
          "output-limit": "Process output exceeded the configured limit.",
          spawn: "Process could not be started.",
          timeout: "Process exceeded the configured timeout."
        };
        reject(
          new ProcessExecutionError(
            reason,
            descriptions[reason],
            child.exitCode,
            output(stdoutChunks),
            output(stderrChunks)
          )
        );
      };
      const abort = (): void => fail("aborted");
      options.signal?.addEventListener("abort", abort, { once: true });
      this.terminateByChild.set(child, () => fail("aborted"));

      timer = startTimer(() => fail("timeout"), options.timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > options.maxStdoutBytes) {
          const remaining = options.maxStdoutBytes - (stdoutBytes - chunk.byteLength);
          if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining));
          fail("output-limit");
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (settled) return;
        stderrBytes += chunk.byteLength;
        if (stderrBytes > options.maxStderrBytes) {
          const remaining = options.maxStderrBytes - (stderrBytes - chunk.byteLength);
          if (remaining > 0) stderrChunks.push(chunk.subarray(0, remaining));
          fail("output-limit");
          return;
        }
        stderrChunks.push(chunk);
      });

      child.once("error", (error) => {
        if (settled) return;
        releaseChild();
        settled = true;
        releaseRequest();
        reject(
          new ProcessExecutionError(
            "spawn",
            `Could not start ${executable}.`,
            null,
            output(stdoutChunks),
            output(stderrChunks),
            error
          )
        );
      });

      child.once("close", (code) => {
        releaseChild();
        if (settled) return;
        settled = true;
        releaseRequest();
        const stdout = output(stdoutChunks);
        const stderr = output(stderrChunks);
        if (code !== 0) {
          reject(new ProcessExecutionError("exit", `Process exited with code ${String(code)}.`, code, stdout, stderr));
          return;
        }
        resolve({ stdout, stderr, exitCode: 0, durationMs: Date.now() - startedAt });
      });

      if (options.signal?.aborted) fail("aborted");
    });
  }

  streamLines(
    executable: string,
    args: readonly string[],
    options: ProcessLineStreamOptions,
    handlers: ProcessLineStreamHandlers
  ): ProcessLineStream {
    if (this.disposed) {
      throw new ProcessExecutionError(
        "aborted",
        "Process runner has been disposed.",
        null,
        "",
        ""
      );
    }
    const child = spawn(executable, [...args], {
      env: options.environment ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;
    let receivedInitialLine = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let startupTimer: ReturnType<typeof setTimeout> | null = null;

    const stderr = (): string => Buffer.concat(stderrChunks).toString("utf8");
    const releaseTimers = (): void => {
      if (startupTimer !== null) {
        cancelTimer(startupTimer);
        startupTimer = null;
      }
    };
    const releaseChild = (): void => {
      if (forceKillTimer !== null) {
        cancelTimer(forceKillTimer);
        forceKillTimer = null;
      }
      this.terminateByChild.delete(child);
    };
    const stopChild = (): void => {
      if (!isRunning(child)) return;
      child.kill("SIGTERM");
      forceKillTimer ??= startTimer(() => {
        if (isRunning(child)) child.kill("SIGKILL");
      }, FORCE_KILL_AFTER_MS);
      forceKillTimer.unref();
    };
    const finish = (notify: boolean, error?: ProcessExecutionError): void => {
      if (settled) return;
      settled = true;
      releaseTimers();
      stopChild();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (notify && error !== undefined) handlers.onError(error);
    };
    const fail = (
      reason: ProcessFailureReason,
      message: string,
      originalError?: unknown
    ): void => {
      finish(
        true,
        new ProcessExecutionError(
          reason,
          message,
          child.exitCode,
          pending.toString("utf8"),
          stderr(),
          originalError
        )
      );
    };
    const emitLine = (lineBuffer: Buffer): boolean => {
      if (lineBuffer.byteLength > options.maxLineBytes) {
        fail("output-limit", "Process stream line exceeded the configured limit.");
        return false;
      }
      const normalized = lineBuffer.at(-1) === 0x0d
        ? lineBuffer.subarray(0, lineBuffer.byteLength - 1)
        : lineBuffer;
      if (normalized.byteLength === 0) return true;
      if (!receivedInitialLine) {
        receivedInitialLine = true;
        releaseTimers();
      }
      try {
        handlers.onLine(normalized.toString("utf8"));
        return true;
      } catch (error) {
        fail("exit", "Process stream handler failed.", error);
        return false;
      }
    };

    this.terminateByChild.set(child, () => finish(false));
    startupTimer = startTimer(() => {
      fail("timeout", "Process stream did not emit its initial frame before the timeout.");
    }, options.startupTimeoutMs);
    startupTimer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (!emitLine(line)) return;
        newline = pending.indexOf(0x0a);
      }
      if (pending.byteLength > options.maxLineBytes) {
        fail("output-limit", "Process stream line exceeded the configured limit.");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.byteLength;
      if (stderrBytes > options.maxStderrBytes) {
        const remaining = options.maxStderrBytes - (stderrBytes - chunk.byteLength);
        if (remaining > 0) stderrChunks.push(chunk.subarray(0, remaining));
        fail("output-limit", "Process stream stderr exceeded the configured limit.");
        return;
      }
      stderrChunks.push(chunk);
    });
    child.once("error", (error) => {
      releaseChild();
      if (settled) return;
      fail("spawn", `Could not start ${executable}.`, error);
    });
    child.once("close", (code) => {
      releaseChild();
      if (settled) return;
      fail(
        "exit",
        code === 0
          ? "Process stream ended unexpectedly."
          : `Process stream exited with code ${String(code)}.`
      );
    });

    return { dispose: () => finish(false) };
  }

  dispose(): void {
    this.disposed = true;
    for (const terminate of [...this.terminateByChild.values()]) terminate();
  }
}
