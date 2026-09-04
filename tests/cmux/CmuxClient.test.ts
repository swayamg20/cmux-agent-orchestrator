import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveTarget } from "../../src/cmux/CmuxClient";
import { CmuxClient } from "../../src/cmux/CmuxClient";
import { decodeTree } from "../../src/cmux/decoders";
import type { CmuxTransport } from "../../src/cmux/CmuxTransport";

const fixture = (name: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`../fixtures/cmux-0.62.2/${name}`, import.meta.url)), "utf8");

describe("resolveTarget", () => {
  it("resolves the exact workspace, pane, and surface tuple", async () => {
    const snapshot = decodeTree(await fixture("tree.json"), 1);
    const resolved = resolveTarget(snapshot, {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "55555555-5555-4555-8555-555555555555"
    });
    expect(resolved.surfaceTitle).toBe("Codex · parser tests");
  });

  it("resolves mixed-case target UUIDs to the authoritative snapshot identity", async () => {
    const snapshot = decodeTree(await fixture("tree.json"), 1);
    const workspace = snapshot.windows[0]!.workspaces[0]!;
    const pane = workspace.panes[0]!;
    const surface = pane.surfaces[0]!;
    workspace.id = "a2222222-a222-4222-8222-a22222222222";
    pane.id = "b3333333-b333-4333-8333-b33333333333";
    surface.id = "c4444444-c444-4444-8444-c44444444444";
    surface.paneId = pane.id;

    expect(
      resolveTarget(snapshot, {
        workspaceId: workspace.id.toUpperCase(),
        paneId: pane.id.toUpperCase(),
        surfaceId: surface.id.toUpperCase()
      })
    ).toMatchObject({
      workspaceId: workspace.id,
      paneId: pane.id,
      surfaceId: surface.id
    });
  });

  it("fails when any part of the tuple is stale", async () => {
    const snapshot = decodeTree(await fixture("tree.json"), 1);
    expect(() =>
      resolveTarget(snapshot, {
        workspaceId: "22222222-2222-4222-8222-222222222222",
        paneId: "33333333-3333-4333-8333-333333333333",
        surfaceId: "99999999-9999-4999-8999-999999999999"
      })
    ).toThrow(/no longer exists/);
  });
});

describe("CmuxClient focus safety", () => {
  it("focuses only after preflight and verifies the same target afterward", async () => {
    const snapshot = decodeTree(await fixture("tree.json"), 1);
    const focused: string[] = [];
    const transport = fakeTransport([snapshot, snapshot], focused);
    const client = new CmuxClient(transport);
    const result = await client.focusExact({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444"
    });
    expect(result.verified).toBe(true);
    expect(focused).toEqual(["44444444-4444-4444-8444-444444444444"]);
  });

  it("reports an unexpected cmux window-count change without cleanup", async () => {
    const snapshot = decodeTree(await fixture("tree.json"), 1);
    const after = { ...snapshot, windows: [...snapshot.windows, { ...snapshot.windows[0]!, id: "99999999-9999-4999-8999-999999999999" }] };
    const client = new CmuxClient(fakeTransport([snapshot, after], []));
    await expect(
      client.focusExact({
        workspaceId: "22222222-2222-4222-8222-222222222222",
        paneId: "33333333-3333-4333-8333-333333333333",
        surfaceId: "44444444-4444-4444-8444-444444444444"
      })
    ).rejects.toThrow(/window count changed unexpectedly/);
  });

  it("accepts the exact focused tuple even when tree selection flags lag behind", async () => {
    const snapshot = decodeTree(await fixture("tree.json"), 1);
    const target = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "55555555-5555-4555-8555-555555555555"
    };
    const after = {
      ...snapshot,
      windows: snapshot.windows.map((window) => ({
        ...window,
        selectedWorkspaceId: null,
        workspaces: window.workspaces.map((workspace) => ({
          ...workspace,
          selected: false,
          panes: workspace.panes.map((pane) => ({
            ...pane,
            selectedSurfaceId: null,
            surfaces: pane.surfaces.map((surface) => ({
              ...surface,
              selected: false,
              focused: false,
              active: false
            }))
          }))
        }))
      }))
    };
    const client = new CmuxClient(fakeTransport([snapshot, after], [], target));

    await expect(client.focusExact(target)).resolves.toMatchObject({ verified: true });
  });

  it("verifies focus when cmux reports the same target with different UUID casing", async () => {
    const snapshot = decodeTree(await fixture("tree.json"), 1);
    const workspace = snapshot.windows[0]!.workspaces[0]!;
    const pane = workspace.panes[0]!;
    const surface = pane.surfaces[0]!;
    workspace.id = "a2222222-a222-4222-8222-a22222222222";
    pane.id = "b3333333-b333-4333-8333-b33333333333";
    surface.id = "c4444444-c444-4444-8444-c44444444444";
    surface.paneId = pane.id;
    const target = {
      workspaceId: workspace.id,
      paneId: pane.id,
      surfaceId: surface.id
    };
    const transport = fakeTransport([snapshot, snapshot], [], {
      workspaceId: target.workspaceId.toUpperCase(),
      paneId: target.paneId.toUpperCase(),
      surfaceId: target.surfaceId.toUpperCase()
    });

    await expect(new CmuxClient(transport).focusExact(target)).resolves.toMatchObject({
      verified: true,
      target
    });
  });

  it("retries focused-target verification for a bounded window when cmux selection propagation lags", async () => {
    const snapshot = decodeTree(await fixture("tree.json"), 1);
    const target = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "55555555-5555-4555-8555-555555555555"
    };
    const transport = fakeTransport([snapshot, snapshot], []);
    let calls = 0;
    transport.focusedTarget = async () => {
      calls += 1;
      return calls === 1
        ? {
            workspaceId: target.workspaceId,
            paneId: target.paneId,
            surfaceId: "44444444-4444-4444-8444-444444444444"
          }
        : target;
    };
    const result = await new CmuxClient(transport).focusExact(target);
    expect(result.verified).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("CmuxClient preview safety", () => {
  it("rejects terminal output attributed to a different pane", async () => {
    const target = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444"
    };
    const transport = fakeTransport([], []);
    transport.readPreview = async () => ({
      ...target,
      paneId: "99999999-9999-4999-8999-999999999999",
      text: "wrong pane output",
      observedAt: 1,
      truncated: false
    });

    await expect(
      new CmuxClient(transport).readPreview(target, { lines: 60, maxBytes: 16 * 1024 })
    ).rejects.toThrow(/different surface/);
  });
});

function fakeTransport(
  snapshots: ReturnType<typeof decodeTree>[],
  focused: string[],
  focusedTarget = {
    workspaceId: "22222222-2222-4222-8222-222222222222",
    paneId: "33333333-3333-4333-8333-333333333333",
    surfaceId: "44444444-4444-4444-8444-444444444444"
  }
): CmuxTransport {
  return {
    probe: async () => ({
      binaryPath: "/cmux",
      versionText: "cmux 0.62.2",
      capabilities: { version: 2, protocol: "cmux-socket", accessMode: "automation", methods: new Set() },
      latencyMs: 1
    }),
    snapshot: async () => snapshots.shift()!,
    notifications: async () => [],
    readPreview: async (target) => ({ ...target, text: "", observedAt: 1, truncated: false }),
    focusedTarget: async () => focusedTarget,
    focus: async (target) => {
      focused.push(target.surfaceId);
    },
    dispose: () => undefined
  };
}
