import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeCapabilities,
  decodeAgents,
  decodeFocusedTarget,
  decodeNotifications,
  decodeTree,
  decodeWorkspaceDirectories
} from "../../src/cmux/decoders";
import { CmuxError } from "../../src/cmux/types";

const fixture = (name: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`../fixtures/cmux-0.62.2/${name}`, import.meta.url)), "utf8");

const modernFixture = (name: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`../fixtures/cmux-modern/${name}`, import.meta.url)), "utf8");

describe("cmux 0.62.2 decoders", () => {
  it("decodes canonical tree identities and joins current directories", async () => {
    const [tree, workspaces] = await Promise.all([fixture("tree.json"), fixture("list-workspaces.json")]);
    const snapshot = decodeTree(tree, 1234, decodeWorkspaceDirectories(workspaces));
    const workspace = snapshot.windows[0]!.workspaces[0]!;
    const surface = workspace.panes[0]!.surfaces[0]!;

    expect(snapshot.observedAt).toBe(1234);
    expect(workspace.currentDirectory).toBe("/Users/example/Projects/agent-cockpit");
    expect(surface.id).toBe("44444444-4444-4444-8444-444444444444");
    expect(surface.selected).toBe(true);
  });

  it("decodes capability feature names and access mode", async () => {
    const capabilities = decodeCapabilities(await fixture("capabilities.json"));
    expect(capabilities.accessMode).toBe("cmuxOnly");
    expect(capabilities.methods.has("surface.read_text")).toBe(true);
  });

  it("decodes the installed notification array shape", async () => {
    const notifications = decodeNotifications(await fixture("notifications.json"));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ isRead: false, title: "Approval required" });
  });

  it("decodes the authoritative focused tuple from identify", async () => {
    expect(decodeFocusedTarget(await fixture("identify.json"))).toEqual({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444"
    });
  });

  it("feature-decodes modern structured agent records with canonical surface identity", async () => {
    expect(decodeAgents(await modernFixture("list-agents.json"))).toEqual([
      {
        surfaceId: "44444444-4444-4444-8444-444444444444",
        state: "working",
        source: "hook",
        sessionId: "55555555-5555-4555-8555-555555555555",
        updatedAt: 1788381000123
      },
      {
        surfaceId: "66666666-6666-4666-8666-666666666666",
        state: "blocked",
        source: "detected",
        sessionId: null,
        updatedAt: 1788381000456
      }
    ]);
  });

  it("rejects ambiguous or unsupported modern agent records", async () => {
    const fixtureText = await modernFixture("list-agents.json");
    expect(() => decodeAgents(fixtureText.replace('"state": "working"', '"state": "complete"')))
      .toThrow(/state.*unsupported/);
    expect(() =>
      decodeAgents(
        fixtureText.replace(
          '"surface": "66666666-6666-4666-8666-666666666666"',
          '"surface": "44444444-4444-4444-8444-444444444444"'
        )
      )
    ).toThrow(/duplicated/);
  });

  it("fails closed on malformed or truncated output", () => {
    expect(() => decodeTree('{"windows":[', Date.now())).toThrowError(CmuxError);
    expect(() => decodeNotifications('{"notifications":[]}')).toThrowError(/must be an array/);
  });

  it("rejects non-canonical identities even when the JSON shape is otherwise valid", async () => {
    const tree = (await fixture("tree.json")).replace(
      '"id": "44444444-4444-4444-8444-444444444444"',
      '"id": "surface:1"'
    );
    expect(() => decodeTree(tree, Date.now())).toThrowError(/canonical UUID/);
  });
});
