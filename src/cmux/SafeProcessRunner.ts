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

export class SafeProcessRunner {
  private readonly terminateByChild = new Map<ChildProcess, (reason: ProcessFailureReason) => void>();
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
      this.terminateByChild.set(child, fail);

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

  dispose(): void {
    this.disposed = true;
    for (const terminate of [...this.terminateByChild.values()]) terminate("aborted");
  }
}
