import { describe, expect, it } from "vitest";
import { SafeProcessRunner } from "../../src/cmux/SafeProcessRunner";

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
});
