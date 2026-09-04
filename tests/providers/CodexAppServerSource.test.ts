import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { setTimeout as startTimer } from "node:timers";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  CodexAppServerSource,
  codexAppServerCommand,
  decodeCodexThreadList,
  type CodexAppServerRequester
} from "../../src/providers/CodexAppServerSource";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: spawnMock
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function appServerChild(): ChildProcessWithoutNullStreams {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true)
  }) as unknown as ChildProcessWithoutNullStreams;
}

const fixture = (): Promise<string> =>
  readFile(fileURLToPath(new URL("../fixtures/providers/codex-thread-list.json", import.meta.url)), "utf8");

describe("CodexAppServerSource", () => {
  it("constructs only the fixed app-server argument array", () => {
    expect(codexAppServerCommand()).toEqual(["app-server", "--listen", "stdio://"]);
  });

  it("decodes titles only for the exact requested working directory", async () => {
    const sessions = decodeCodexThreadList(JSON.parse(await fixture()) as unknown, "/workspace/project");
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      sessionId: "11111111-1111-4111-8111-111111111111",
      title: "Implement exact conversation titles",
      titleSource: "explicit-name",
      cwd: "/workspace/project",
      status: "idle",
      parentSessionId: null,
      sourceKind: "cli"
    });
    expect(sessions[1]).toMatchObject({
      title: "Review parser boundaries",
      titleSource: "provider-preview"
    });
  });

  it("requests a bounded repository-filtered thread list", async () => {
    const response = JSON.parse(await fixture()) as unknown;
    const request = vi.fn(async () => response);
    const requester: CodexAppServerRequester = { request, dispose: vi.fn() };
    const sessions = await new CodexAppServerSource(requester).list("/workspace/project");
    expect(sessions).toHaveLength(2);
    expect(request).toHaveBeenCalledWith(
      "thread/list",
      { cwd: "/workspace/project", limit: 50, useStateDbOnly: true },
      undefined
    );
  });

  it("explicitly disables turn hydration for an exact thread read", async () => {
    const response = JSON.parse(await fixture()) as { data: unknown[] };
    const request = vi.fn(async () => ({ thread: response.data[0] }));
    const requester: CodexAppServerRequester = { request, dispose: vi.fn() };
    const session = await new CodexAppServerSource(requester).get(
      "11111111-1111-4111-8111-111111111111",
      "/workspace/project"
    );
    expect(session?.title).toBe("Implement exact conversation titles");
    expect(request).toHaveBeenCalledWith(
      "thread/read",
      {
        threadId: "11111111-1111-4111-8111-111111111111",
        includeTurns: false
      },
      undefined
    );
  });

  it("does not start an app-server after disposal while binary discovery is pending", async () => {
    const discovery = deferred<string>();
    const client = new CodexAppServerClient();
    (client as unknown as { binaryPath: Promise<string> | null }).binaryPath = discovery.promise;

    const request = client.request("thread/list", {});
    client.dispose();
    discovery.resolve("/usr/bin/true");

    await expect(request).rejects.toThrow("disposed");
  });

  it("settles an active exchange immediately on disposal and ignores late initialization", async () => {
    const child = appServerChild();
    const writes: string[] = [];
    child.stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));
    spawnMock.mockReturnValueOnce(child);
    const client = new CodexAppServerClient();
    (client as unknown as { binaryPath: Promise<string> | null }).binaryPath =
      Promise.resolve("/opt/homebrew/bin/codex");

    const request = client.request("thread/list", { cwd: "/repository" });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    client.dispose();

    const outcome = await Promise.race([
      request.then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.message : String(error)
      ),
      new Promise<string>((resolve) => startTimer(() => resolve("still pending"), 25))
    ]);
    const writesAtDisposal = writes.length;
    child.stdout.emit("data", Buffer.from('{"id":1,"result":{}}\n'));
    await Promise.resolve();
    Object.assign(child, { exitCode: 0 });
    child.emit("close", 0);
    await request.catch(() => undefined);

    expect(outcome).toContain("disposed");
    expect(writes).toHaveLength(writesAtDisposal);
  });
});
