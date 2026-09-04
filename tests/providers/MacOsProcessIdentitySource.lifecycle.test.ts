import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as startTimer } from "node:timers";
import { describe, expect, it, vi } from "vitest";
import { MacOsProcessIdentitySource } from "../../src/providers/identity/MacOsProcessIdentitySource";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: spawnMock
}));

function pipelineChild(): { child: ChildProcess; kill: ReturnType<typeof vi.fn> } {
  const kill = vi.fn(() => true);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 123,
    exitCode: null,
    signalCode: null,
    kill
  }) as unknown as ChildProcess;
  return { child, kill };
}

describe("MacOsProcessIdentitySource lifecycle", () => {
  it("settles an active surface lookup immediately when disposed", async () => {
    const ps = pipelineChild();
    const grep = pipelineChild();
    spawnMock.mockReturnValueOnce(ps.child).mockReturnValueOnce(grep.child);
    const source = new MacOsProcessIdentitySource();

    const lookup = source.readSurfaceId(123);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    source.dispose();

    const outcome = await Promise.race([
      lookup.then((value) => ({ settled: true as const, value })),
      new Promise<{ settled: false }>((resolve) =>
        startTimer(() => resolve({ settled: false }), 25)
      )
    ]);
    if (!outcome.settled) {
      grep.child.emit("close", 0);
      await lookup;
    }

    expect(outcome).toEqual({ settled: true, value: null });
    expect(ps.kill).toHaveBeenCalledWith("SIGTERM");
    expect(grep.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
