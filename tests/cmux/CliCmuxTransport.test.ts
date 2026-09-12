import { describe, expect, it, vi } from "vitest";
import {
  CliCmuxTransport,
  type CmuxEventTimerHandle,
  type CmuxEventTimerScheduler
} from "../../src/cmux/CliCmuxTransport";
import {
  ProcessExecutionError,
  type ProcessLineStream,
  type ProcessLineStreamHandlers,
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
  readonly timeoutBudgetsSeen: number[] = [];

  override async run(
    _executable: string,
    args: readonly string[],
    options: Parameters<SafeProcessRunner["run"]>[2]
  ): Promise<ProcessResult> {
    this.argumentsSeen.push([...args]);
    this.timeoutBudgetsSeen.push(options.timeoutMs);
    if (args.includes("events")) {
      throw new ProcessExecutionError(
        "exit",
        "Process exited with code 1.",
        1,
        "",
        "Error: Unknown command: events"
      );
    }
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
  override async run(_executable: string, args: readonly string[]): Promise<ProcessResult> {
    const command = args.includes("sessions") ? "sessions" : "list-agents";
    throw new ProcessExecutionError(
      "exit",
      "Process exited with code 1.",
      1,
      "",
      `Error: Unknown command: ${command}`
    );
  }
}

class CurrentSessionCommandRunner extends SafeProcessRunner {
  readonly argumentsSeen: string[][] = [];

  override async run(_executable: string, args: readonly string[]): Promise<ProcessResult> {
    this.argumentsSeen.push([...args]);
    if (args.includes("list-agents")) {
      throw new ProcessExecutionError(
        "exit",
        "Process exited with code 1.",
        1,
        "",
        "Error: Unknown command: list-agents"
      );
    }
    if (args.includes("sessions")) {
      return {
        stdout: JSON.stringify({
          sessions: [{
            agent: "codex",
            agent_lifecycle: "running",
            runtime_status: "running",
            active_prompt_turn_id: "81111111-1111-4111-8111-111111111111",
            last_prompt_turn_id: "81111111-1111-4111-8111-111111111111",
            active_for_surface: true,
            active_for_workspace: false,
            default_visible: true,
            stored_pid_exists: true,
            session_id: "55555555-5555-4555-8555-555555555555",
            surface_id: "44444444-4444-4444-8444-444444444444",
            workspace_id: "22222222-2222-4222-8222-222222222222",
            updated_at_unix: 1788381000.123
          }]
        }),
        stderr: "",
        exitCode: 0,
        durationMs: 1
      };
    }
    throw new Error(`Unexpected cmux command: ${args.join(" ")}`);
  }
}

class EventStreamRunner extends SafeProcessRunner {
  readonly argumentsSeen: string[][] = [];
  handlers: ProcessLineStreamHandlers | null = null;
  streamDisposed = false;

  override async run(_executable: string, args: readonly string[]): Promise<ProcessResult> {
    this.argumentsSeen.push([...args]);
    if (args.includes("--version")) {
      return { stdout: "cmux 1.0.0", stderr: "", exitCode: 0, durationMs: 1 };
    }
    return {
      stdout: JSON.stringify({
        version: 2,
        protocol: "cmux-socket",
        access_mode: "automation",
        methods: [
          "system.tree",
          "workspace.list",
          "surface.read_text",
          "surface.focus",
          "system.identify",
          "notification.list",
          "events.stream"
        ]
      }),
      stderr: "",
      exitCode: 0,
      durationMs: 1
    };
  }

  override streamLines(
    _executable: string,
    args: readonly string[],
    _options: Parameters<SafeProcessRunner["streamLines"]>[2],
    handlers: ProcessLineStreamHandlers
  ): ProcessLineStream {
    this.argumentsSeen.push([...args]);
    this.handlers = handlers;
    return { dispose: () => { this.streamDisposed = true; } };
  }
}

class HelpDetectedEventStreamRunner extends EventStreamRunner {
  override async run(_executable: string, args: readonly string[]): Promise<ProcessResult> {
    this.argumentsSeen.push([...args]);
    if (args.includes("--version")) {
      return { stdout: "cmux 0.64.22", stderr: "", exitCode: 0, durationMs: 1 };
    }
    if (args.includes("capabilities")) {
      return {
        stdout: JSON.stringify({
          version: 2,
          protocol: "cmux-socket",
          access_mode: "automation",
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
    if (args.join(" ") === "events --help") {
      return { stdout: "Usage: cmux events [options]", stderr: "", exitCode: 0, durationMs: 1 };
    }
    throw new Error(`Unexpected cmux command: ${args.join(" ")}`);
  }
}

class EventTimerHarness implements CmuxEventTimerScheduler {
  private pending: {
    handle: CmuxEventTimerHandle;
    callback: () => void;
    delayMs: number;
  } | null = null;
  readonly cleared: CmuxEventTimerHandle[] = [];

  set(callback: () => void, delayMs: number): CmuxEventTimerHandle {
    const handle = { unref: () => undefined };
    this.pending = { handle, callback, delayMs };
    return handle;
  }

  clear(handle: CmuxEventTimerHandle): void {
    this.cleared.push(handle);
    if (this.pending?.handle === handle) this.pending = null;
  }

  currentDelayMs(): number | null {
    return this.pending?.delayMs ?? null;
  }

  fire(): void {
    const pending = this.pending;
    this.pending = null;
    pending?.callback();
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

  it("falls back from legacy list-agents to current cmux sessions", async () => {
    const runner = new CurrentSessionCommandRunner();
    const transport = new CliCmuxTransport("/path/to/cmux", runner);

    await expect(transport.agents()).resolves.toEqual([{
      surfaceId: "44444444-4444-4444-8444-444444444444",
      state: "working",
      source: "hook",
      sessionId: "55555555-5555-4555-8555-555555555555",
      updatedAt: 1788381000123
    }]);
    expect(runner.argumentsSeen).toEqual([
      ["--json", "--id-format", "uuids", "list-agents"],
      ["sessions", "--json"]
    ]);
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

  it("keeps a bounded five-second budget for a cold password-mode socket handshake", async () => {
    const runner = new PasswordModeRunner();
    const transport = new CliCmuxTransport(
      "/Applications/cmux.app/Contents/Resources/bin/cmux",
      runner
    );

    await transport.probe();
    expect(runner.timeoutBudgetsSeen).toEqual([5_000, 5_000, 5_000]);
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

describe("CliCmuxTransport event streaming", () => {
  it("feature-detects events.stream and emits only normalized refresh signals", async () => {
    const runner = new EventStreamRunner();
    const transport = new CliCmuxTransport("/path/to/cmux", runner);
    await transport.probe();
    const signals: unknown[] = [];
    const onReady = vi.fn();
    const stop = transport.subscribeEvents({
      onReady,
      onSignal: (signal) => signals.push(signal),
      onError: (error) => { throw error; }
    });

    expect(stop).not.toBeNull();
    expect(onReady).not.toHaveBeenCalled();
    expect(runner.argumentsSeen.at(-1)).toEqual(["events", "--reconnect"]);
    runner.handlers?.onLine(
      JSON.stringify({
        type: "ack",
        protocol: "cmux-events",
        version: 1,
        boot_id: "11111111-1111-4111-8111-111111111111",
        heartbeat_interval_seconds: 15,
        resume: { gap: false }
      })
    );
    expect(onReady).toHaveBeenCalledOnce();
    runner.handlers?.onLine(
      JSON.stringify({
        type: "event",
        protocol: "cmux-events",
        version: 1,
        boot_id: "11111111-1111-4111-8111-111111111111",
        seq: 1,
        name: "surface.created",
        category: "surface",
        payload: { secret: "discarded" }
      })
    );

    expect(signals).toEqual([
      {
        scope: "topology",
        bootId: "11111111-1111-4111-8111-111111111111",
        seq: 1,
        name: "surface.created",
        reason: "change"
      }
    ]);
    stop?.();
    expect(runner.streamDisposed).toBe(true);
    transport.dispose();
  });

  it("stops and reports a silent stream after three advertised heartbeat intervals", async () => {
    const runner = new EventStreamRunner();
    const timers = new EventTimerHarness();
    const transport = new CliCmuxTransport("/path/to/cmux", runner, Date.now, timers);
    await transport.probe();
    const onReady = vi.fn();
    const errors: unknown[] = [];
    transport.subscribeEvents({
      onReady,
      onSignal: () => undefined,
      onError: (error) => errors.push(error)
    });

    runner.handlers?.onLine(
      JSON.stringify({
        type: "ack",
        protocol: "cmux-events",
        version: 1,
        boot_id: "11111111-1111-4111-8111-111111111111",
        heartbeat_interval_seconds: 15,
        resume: { gap: false }
      })
    );
    expect(onReady).toHaveBeenCalledOnce();
    expect(timers.currentDelayMs()).toBe(45_000);

    runner.handlers?.onLine(
      JSON.stringify({
        type: "heartbeat",
        protocol: "cmux-events",
        version: 1,
        boot_id: "11111111-1111-4111-8111-111111111111"
      })
    );
    expect(errors).toEqual([]);
    expect(timers.cleared).toHaveLength(1);
    expect(timers.currentDelayMs()).toBe(45_000);
    timers.fire();

    expect(runner.streamDisposed).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "timeout",
      message: "cmux event streaming stopped producing frames before its heartbeat deadline."
    });
    timers.fire();
    expect(errors).toHaveLength(1);
    transport.dispose();
  });

  it("keeps event streaming disabled when the capability is absent", async () => {
    const runner = new PasswordModeRunner();
    const transport = new CliCmuxTransport("/path/to/cmux", runner);
    await transport.probe();
    expect(
      transport.subscribeEvents({
        onReady: () => undefined,
        onSignal: () => undefined,
        onError: () => undefined
      })
    ).toBeNull();
    transport.dispose();
  });

  it("feature-detects the current events command when the legacy method token is absent", async () => {
    const runner = new HelpDetectedEventStreamRunner();
    const transport = new CliCmuxTransport("/path/to/cmux", runner);
    await transport.probe();

    expect(
      transport.subscribeEvents({
        onReady: () => undefined,
        onSignal: () => undefined,
        onError: () => undefined
      })
    ).not.toBeNull();
    expect(runner.argumentsSeen).toContainEqual(["events", "--help"]);
    transport.dispose();
  });
});
