import { describe, expect, it, vi } from "vitest";
import {
  CmuxApplicationActivator,
  type ActivationProcessRunner
} from "../../src/actions/CmuxApplicationActivator";

function processRunner() {
  const run = vi.fn<ActivationProcessRunner["run"]>(async () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 1
  }));
  const dispose = vi.fn();
  return { runner: { run, dispose } satisfies ActivationProcessRunner, run, dispose };
}

describe("CmuxApplicationActivator", () => {
  it("uses bounded LaunchServices activation without a shell", async () => {
    const { runner, run } = processRunner();
    const activator = new CmuxApplicationActivator(runner, "darwin");
    const controller = new AbortController();

    await activator.activate(controller.signal);

    expect(run).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-b", "com.cmuxterm.app"],
      {
        timeoutMs: 3_000,
        maxStdoutBytes: 4_096,
        maxStderrBytes: 4_096,
        signal: controller.signal
      }
    );
  });

  it("fails closed outside macOS without starting a process", async () => {
    const { runner, run } = processRunner();
    const activator = new CmuxApplicationActivator(runner, "linux");

    await expect(activator.activate()).rejects.toThrow(
      "Bringing cmux forward is available only on macOS."
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("disposes its bounded process runner", () => {
    const { runner, dispose } = processRunner();
    const activator = new CmuxApplicationActivator(runner, "darwin");

    activator.dispose();

    expect(dispose).toHaveBeenCalledOnce();
  });
});
