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
});
