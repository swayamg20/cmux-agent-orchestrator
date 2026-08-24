import { spawn, type ChildProcess } from "node:child_process";

const FORCE_KILL_AFTER_MS = 250;

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
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
}

export class SafeProcessRunner {
  private readonly children = new Set<ChildProcess>();
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
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      this.children.add(child);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failureReason: ProcessFailureReason | null = null;
      let settled = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

      const output = (chunks: readonly Buffer[]): string => Buffer.concat(chunks).toString("utf8");
      const terminate = (reason: ProcessFailureReason): void => {
        failureReason ??= reason;
        if (!isRunning(child)) return;
        child.kill("SIGTERM");
        forceKillTimer ??= setTimeout(() => {
          if (isRunning(child)) child.kill("SIGKILL");
        }, FORCE_KILL_AFTER_MS);
      };
      const abort = (): void => terminate("aborted");
      options.signal?.addEventListener("abort", abort, { once: true });

      const timer = setTimeout(() => terminate("timeout"), options.timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > options.maxStdoutBytes) {
          terminate("output-limit");
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > options.maxStderrBytes) {
          terminate("output-limit");
          return;
        }
        stderrChunks.push(chunk);
      });

      const cleanup = (): void => {
        clearTimeout(timer);
        if (forceKillTimer !== null) clearTimeout(forceKillTimer);
        options.signal?.removeEventListener("abort", abort);
        this.children.delete(child);
      };

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
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
        if (settled) return;
        settled = true;
        cleanup();
        const stdout = output(stdoutChunks);
        const stderr = output(stderrChunks);
        if (failureReason !== null) {
          const descriptions: Record<ProcessFailureReason, string> = {
            aborted: "Process was aborted.",
            exit: "Process failed.",
            "output-limit": "Process output exceeded the configured limit.",
            spawn: "Process could not be started.",
            timeout: "Process exceeded the configured timeout."
          };
          reject(new ProcessExecutionError(failureReason, descriptions[failureReason], code, stdout, stderr));
          return;
        }
        if (code !== 0) {
          reject(new ProcessExecutionError("exit", `Process exited with code ${String(code)}.`, code, stdout, stderr));
          return;
        }
        resolve({ stdout, stderr, exitCode: 0, durationMs: Date.now() - startedAt });
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const child of this.children) {
      if (!isRunning(child)) continue;
      child.kill("SIGTERM");
      const forceKillTimer = setTimeout(() => {
        if (isRunning(child)) child.kill("SIGKILL");
      }, FORCE_KILL_AFTER_MS);
      forceKillTimer.unref();
    }
    this.children.clear();
  }
}
