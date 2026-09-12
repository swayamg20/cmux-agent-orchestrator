import { SafeProcessRunner } from "../cmux/SafeProcessRunner";
import type { ProcessResult, ProcessRunOptions } from "../cmux/SafeProcessRunner";

const OPEN_EXECUTABLE = "/usr/bin/open";
const CMUX_BUNDLE_IDENTIFIER = "com.cmuxterm.app";

export interface ApplicationActivator {
  activate(signal?: AbortSignal): Promise<void>;
  dispose(): void;
}

export interface ActivationProcessRunner {
  run(
    executable: string,
    args: readonly string[],
    options: ProcessRunOptions
  ): Promise<ProcessResult>;
  dispose(): void;
}

/** Foregrounds the existing cmux application through bounded macOS LaunchServices. */
export class CmuxApplicationActivator implements ApplicationActivator {
  constructor(
    private readonly runner: ActivationProcessRunner = new SafeProcessRunner(),
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  async activate(signal?: AbortSignal): Promise<void> {
    if (this.platform !== "darwin") {
      throw new Error("Bringing cmux forward is available only on macOS.");
    }
    await this.runner.run(OPEN_EXECUTABLE, ["-b", CMUX_BUNDLE_IDENTIFIER], {
      timeoutMs: 3_000,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 4_096,
      signal
    });
  }

  dispose(): void {
    this.runner.dispose();
  }
}
