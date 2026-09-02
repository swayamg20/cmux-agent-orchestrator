import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerSource,
  codexAppServerCommand,
  decodeCodexThreadList,
  type CodexAppServerRequester
} from "../../src/providers/CodexAppServerSource";

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
});
