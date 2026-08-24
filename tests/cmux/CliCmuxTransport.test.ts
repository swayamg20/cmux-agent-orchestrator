import { describe, expect, it } from "vitest";
import { CliCmuxTransport } from "../../src/cmux/CliCmuxTransport";
import {
  ProcessExecutionError,
  type ProcessResult,
  SafeProcessRunner
} from "../../src/cmux/SafeProcessRunner";

class FailedSocketWriteRunner extends SafeProcessRunner {
  private calls = 0;

  override async run(): Promise<ProcessResult> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        stdout: "cmux 0.62.2 (77) [test]",
        stderr: "",
        exitCode: 0,
        durationMs: 1
      };
    }
    throw new ProcessExecutionError(
      "exit",
      "Process exited with code 1.",
      1,
      "",
      "Error: Failed to write to socket"
    );
  }
}

class AuthenticationRequiredRunner extends SafeProcessRunner {
  private calls = 0;

  override async run(): Promise<ProcessResult> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        stdout: "cmux 0.62.2 (77) [test]",
        stderr: "",
        exitCode: 0,
        durationMs: 1
      };
    }
    throw new ProcessExecutionError(
      "exit",
      "Process exited with code 1.",
      1,
      "",
      "Authentication required — send auth <password> first"
    );
  }
}

class PasswordModeRunner extends SafeProcessRunner {
  readonly argumentsSeen: string[][] = [];

  override async run(_executable: string, args: readonly string[]): Promise<ProcessResult> {
    this.argumentsSeen.push([...args]);
    if (this.argumentsSeen.length === 1) {
      return {
        stdout: "cmux 0.62.2 (77) [test]",
        stderr: "",
        exitCode: 0,
        durationMs: 1
      };
    }
    return {
      stdout: JSON.stringify({
        version: 2,
        protocol: "cmux-socket",
        access_mode: "password",
        methods: [
          "system.tree",
          "workspace.list",
          "surface.read_text",
          "surface.focus",
          "system.identify",
          "notification.list"
        ]
      }),
      stderr: "",
      exitCode: 0,
      durationMs: 1
    };
  }
}

describe("CliCmuxTransport error classification", () => {
  it("maps the installed cmux socket-write rejection to access-blocked", async () => {
    const transport = new CliCmuxTransport("/Applications/cmux.app/Contents/Resources/bin/cmux", new FailedSocketWriteRunner());

    await expect(transport.probe()).rejects.toMatchObject({
      code: "access-blocked",
      message: "cmux rejected this normally launched client. Complete the one-time Socket Control Mode setup in cmux Settings."
    });
    transport.dispose();
  });

  it("maps missing password authentication to actionable setup guidance", async () => {
    const transport = new CliCmuxTransport(
      "/Applications/cmux.app/Contents/Resources/bin/cmux",
      new AuthenticationRequiredRunner()
    );

    await expect(transport.probe()).rejects.toMatchObject({
      code: "access-blocked",
      message:
        "cmux Password mode requires a valid Socket Password saved in cmux Settings before external clients can connect."
    });
    transport.dispose();
  });

  it("lets the cmux CLI own saved-password authentication without passing a secret", async () => {
    const runner = new PasswordModeRunner();
    const transport = new CliCmuxTransport(
      "/Applications/cmux.app/Contents/Resources/bin/cmux",
      runner
    );

    await expect(transport.probe()).resolves.toMatchObject({
      capabilities: { accessMode: "password" }
    });
    expect(runner.argumentsSeen.flat()).not.toContain("--password");
    transport.dispose();
  });
});
