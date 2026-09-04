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

class UnsupportedAgentCommandRunner extends SafeProcessRunner {
  override async run(): Promise<ProcessResult> {
    throw new ProcessExecutionError(
      "exit",
      "Process exited with code 1.",
      1,
      "",
      "Error: Unknown command: list-agents"
    );
  }
}

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function treeResult(): ProcessResult {
  return {
    stdout: JSON.stringify({
      windows: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          index: 0,
          current: true,
          visible: true,
          active: true,
          selected_workspace_id: WORKSPACE_ID,
          workspaces: [
            {
              id: WORKSPACE_ID,
              index: 0,
              title: "repository",
              selected: true,
              active: true,
              pinned: false,
              panes: []
            }
          ]
        }
      ]
    }),
    stderr: "",
    exitCode: 0,
    durationMs: 1
  };
}

function workspaceListResult(currentDirectory: string): ProcessResult {
  return {
    stdout: JSON.stringify({
      workspaces: [{ id: WORKSPACE_ID, current_directory: currentDirectory }]
    }),
    stderr: "",
    exitCode: 0,
    durationMs: 1
  };
}

class OutOfOrderDirectoryRunner extends SafeProcessRunner {
  readonly resolveDirectoryRequests: Array<(currentDirectory: string) => void> = [];

  override async run(_executable: string, args: readonly string[]): Promise<ProcessResult> {
    if (args.includes("tree")) return treeResult();
    if (args.includes("list-workspaces")) {
      return await new Promise<ProcessResult>((resolve) => {
        this.resolveDirectoryRequests.push((currentDirectory) => {
          resolve(workspaceListResult(currentDirectory));
        });
      });
    }
    throw new Error(`Unexpected cmux command: ${args.join(" ")}`);
  }
}

describe("CliCmuxTransport error classification", () => {
  it("treats an absent list-agents command as a feature gap, not a connection failure", async () => {
    const transport = new CliCmuxTransport(
      "/Applications/cmux.app/Contents/Resources/bin/cmux",
      new UnsupportedAgentCommandRunner()
    );

    await expect(transport.agents()).resolves.toBeNull();
    transport.dispose();
  });

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

describe("CliCmuxTransport workspace directory cache", () => {
  it("does not let an older directory refresh replace a newer result", async () => {
    let now = 100;
    const runner = new OutOfOrderDirectoryRunner();
    const transport = new CliCmuxTransport("/path/to/cmux", runner, () => now);

    const olderSnapshot = transport.snapshot();
    now = 101;
    const newerSnapshot = transport.snapshot();
    expect(runner.resolveDirectoryRequests).toHaveLength(2);

    runner.resolveDirectoryRequests[1]?.("/repositories/new");
    await expect(newerSnapshot).resolves.toMatchObject({
      windows: [{ workspaces: [{ currentDirectory: "/repositories/new" }] }]
    });

    runner.resolveDirectoryRequests[0]?.("/repositories/old");
    await expect(olderSnapshot).resolves.toMatchObject({
      windows: [{ workspaces: [{ currentDirectory: "/repositories/old" }] }]
    });

    now = 102;
    await expect(transport.snapshot()).resolves.toMatchObject({
      windows: [{ workspaces: [{ currentDirectory: "/repositories/new" }] }]
    });
    transport.dispose();
  });
});
