import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { SafeProcessRunner } from "../../src/cmux/SafeProcessRunner";
import type { ProcessExecutionError } from "../../src/cmux/SafeProcessRunner";

describe("SafeProcessRunner", () => {
  it("passes arguments without a shell", async () => {
    const runner = new SafeProcessRunner();
    const result = await runner.run("/usr/bin/printf", ["%s", "$(echo unsafe)"], {
      timeoutMs: 1_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024
    });
    expect(result.stdout).toBe("$(echo unsafe)");
    runner.dispose();
  });

  it("terminates output beyond the configured bound", async () => {
    const runner = new SafeProcessRunner();
    await expect(
      runner.run("/usr/bin/printf", ["%s", "x".repeat(200)], {
        timeoutMs: 1_000,
        maxStdoutBytes: 32,
        maxStderrBytes: 1_024
      })
    ).rejects.toMatchObject({ reason: "output-limit" });
    runner.dispose();
  });

  it("enforces the deadline even when its exact child ignores SIGTERM", async () => {
    const runner = new SafeProcessRunner();
    await expect(
      runner.run(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
        timeoutMs: 25,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024
      })
    ).rejects.toMatchObject({ reason: "timeout" });
    runner.dispose();
  });

  it("settles the deadline without waiting for a descendant that inherited its output pipes", async () => {
    const runner = new SafeProcessRunner();
    const script = [
      "const {spawn}=require('node:child_process');",
      "spawn(process.execPath,['-e','setTimeout(()=>{},800)'],{stdio:['ignore','inherit','inherit']});",
      "process.on('SIGTERM',()=>process.exit(0));",
      "setInterval(()=>{},1000);"
    ].join("");
    const startedAt = Date.now();

    await expect(
      runner.run(process.execPath, ["-e", script], {
        timeoutMs: 100,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024
      })
    ).rejects.toMatchObject({ reason: "timeout" });

    expect(Date.now() - startedAt).toBeLessThan(500);
    runner.dispose();
  });

  it("rejects active work as aborted when the runner is disposed", async () => {
    const runner = new SafeProcessRunner();
    const pending = runner.run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024
    });

    runner.dispose();

    await expect(pending).rejects.toMatchObject({ reason: "aborted" });
  });

  it("streams complete lines without invoking a shell", async () => {
    const runner = new SafeProcessRunner();
    const lines: string[] = [];
    let resolveLines!: () => void;
    const received = new Promise<void>((resolve) => {
      resolveLines = resolve;
    });
    const stream = runner.streamLines(
      process.execPath,
      ["-e", "process.stdout.write('$(echo unsafe)\\nsecond\\n');setInterval(()=>{},1000)"],
      { startupTimeoutMs: 1_000, maxLineBytes: 1_024, maxStderrBytes: 1_024 },
      {
        onLine: (line) => {
          lines.push(line);
          if (lines.length === 2) resolveLines();
        },
        onError: () => undefined
      }
    );

    await received;
    expect(lines).toEqual(["$(echo unsafe)", "second"]);
    stream.dispose();
    runner.dispose();
  });

  it("terminates a stream when one JSONL line exceeds its bound", async () => {
    const runner = new SafeProcessRunner();
    const failure = new Promise<string>((resolve) => {
      runner.streamLines(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(200))"],
        { startupTimeoutMs: 1_000, maxLineBytes: 32, maxStderrBytes: 1_024 },
        {
          onLine: () => undefined,
          onError: (error) => resolve(error.reason)
        }
      );
    });

    await expect(failure).resolves.toBe("output-limit");
    runner.dispose();
  });

  it("reports a stream spawn failure exactly once", async () => {
    const runner = new SafeProcessRunner();
    let errorCount = 0;
    const failure = new Promise<ProcessExecutionError>((resolve) => {
      runner.streamLines(
        "/definitely/not/a/real/cmux-agent-orchestrator-command",
        [],
        { startupTimeoutMs: 1_000, maxLineBytes: 1_024, maxStderrBytes: 1_024 },
        {
          onLine: () => undefined,
          onError: (error) => {
            errorCount += 1;
            resolve(error);
          }
        }
      );
    });

    const error = await failure;
    await delay(0);
    expect(error.reason).toBe("spawn");
    expect(error.originalError).toBeInstanceOf(Error);
    expect(errorCount).toBe(1);
    runner.dispose();
  });

  it("reports a throwing line handler as a bounded stream failure", async () => {
    const runner = new SafeProcessRunner();
    const failure = new Promise<ProcessExecutionError>((resolve) => {
      runner.streamLines(
        process.execPath,
        ["-e", "process.stdout.write('ready\\n');setInterval(()=>{},1000)"],
        { startupTimeoutMs: 1_000, maxLineBytes: 1_024, maxStderrBytes: 1_024 },
        {
          onLine: () => {
            throw new Error("simulated handler failure");
          },
          onError: resolve
        }
      );
    });

    const error = await failure;
    expect(error.reason).toBe("exit");
    expect(error.message).toBe("Process stream handler failed.");
    expect(error.originalError).toMatchObject({ message: "simulated handler failure" });
    runner.dispose();
  });

  it("reports clean EOF after delivering every complete line", async () => {
    const runner = new SafeProcessRunner();
    const lines: string[] = [];
    const failure = new Promise<ProcessExecutionError>((resolve) => {
      runner.streamLines(
        process.execPath,
        ["-e", "process.stdout.write('ready\\n')"],
        { startupTimeoutMs: 1_000, maxLineBytes: 1_024, maxStderrBytes: 1_024 },
        {
          onLine: (line) => lines.push(line),
          onError: resolve
        }
      );
    });

    const error = await failure;
    expect(lines).toEqual(["ready"]);
    expect(error.reason).toBe("exit");
    expect(error.message).toBe("Process stream ended unexpectedly.");
    runner.dispose();
  });

  it("terminates a stream when stderr exceeds its configured bound", async () => {
    const runner = new SafeProcessRunner();
    const failure = new Promise<ProcessExecutionError>((resolve) => {
      runner.streamLines(
        process.execPath,
        ["-e", "process.stderr.write('x'.repeat(200));setInterval(()=>{},1000)"],
        { startupTimeoutMs: 1_000, maxLineBytes: 1_024, maxStderrBytes: 32 },
        {
          onLine: () => undefined,
          onError: resolve
        }
      );
    });

    const error = await failure;
    expect(error.reason).toBe("output-limit");
    expect(Buffer.byteLength(error.stderr)).toBe(32);
    runner.dispose();
  });

  it("keeps the startup deadline until the first complete stream line", async () => {
    const runner = new SafeProcessRunner();
    let stream!: ReturnType<SafeProcessRunner["streamLines"]>;
    const outcome = new Promise<string>((resolve) => {
      stream = runner.streamLines(
        process.execPath,
        ["-e", "process.stdout.write('{');setInterval(()=>{},1000)"],
        { startupTimeoutMs: 50, maxLineBytes: 1_024, maxStderrBytes: 1_024 },
        {
          onLine: () => resolve("line"),
          onError: (error) => resolve(error.reason)
        }
      );
    });

    const result = await Promise.race([
      outcome,
      delay(500, "still-running")
    ]);
    stream.dispose();
    runner.dispose();

    expect(result).toBe("timeout");
  });
});
