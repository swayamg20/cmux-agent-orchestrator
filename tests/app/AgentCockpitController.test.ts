import type { App, Plugin } from "obsidian";
import { describe, expect, it } from "vitest";
import { AgentCockpitController } from "../../src/app/AgentCockpitController";
import { CmuxClient } from "../../src/cmux/CmuxClient";
import type { CmuxTransport } from "../../src/cmux/CmuxTransport";
import { CmuxError, type CmuxSnapshot } from "../../src/cmux/types";

function snapshot(observedAt: number): CmuxSnapshot {
  return {
    observedAt,
    windows: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        index: 0,
        current: true,
        visible: true,
        active: true,
        selectedWorkspaceId: "22222222-2222-4222-8222-222222222222",
        workspaces: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            index: 0,
            title: "repository",
            selected: true,
            active: true,
            pinned: false,
            currentDirectory: "/repository",
            panes: [
              {
                id: "33333333-3333-4333-8333-333333333333",
                index: 0,
                focused: true,
                active: true,
                selectedSurfaceId: "44444444-4444-4444-8444-444444444444",
                surfaces: [
                  {
                    id: "44444444-4444-4444-8444-444444444444",
                    paneId: "33333333-3333-4333-8333-333333333333",
                    index: 0,
                    indexInPane: 0,
                    title: "repository",
                    type: "terminal",
                    selected: true,
                    focused: true,
                    active: true
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}

describe("AgentCockpitController connection failures", () => {
  it("preserves an initial access-blocked error during later manual refresh attempts", async () => {
    const app = {
      vault: {
        getAbstractFileByPath: () => null
      }
    } as unknown as App;
    const plugin = {
      loadData: async () => undefined,
      saveData: async () => undefined
    } as unknown as Plugin;
    const controller = new AgentCockpitController(app, plugin, async () => {
      throw new CmuxError(
        "access-blocked",
        "cmux rejected this external client. Its Socket Control Mode may still be cmuxOnly."
      );
    });

    await controller.initialize();
    expect(controller.store.getState().connection).toMatchObject({
      status: "access-blocked",
      message: "cmux rejected this external client. Its Socket Control Mode may still be cmuxOnly."
    });

    await Promise.all([controller.refreshTopology(), controller.refreshNotifications()]);
    expect(controller.store.getState().connection.status).toBe("access-blocked");
    controller.dispose();
  });

  it("classifies a new surface once without reading terminal output on later global refreshes", async () => {
    let snapshotCalls = 0;
    let notificationCalls = 0;
    let previewCalls = 0;
    const transport: CmuxTransport = {
      probe: async () => ({
        binaryPath: "/cmux",
        versionText: "cmux 0.62.2",
        capabilities: {
          version: 2,
          protocol: "cmux-socket",
          accessMode: "automation",
          methods: new Set()
        },
        latencyMs: 1
      }),
      snapshot: async () => snapshot(++snapshotCalls),
      notifications: async () => {
        notificationCalls += 1;
        return [];
      },
      readPreview: async (target) => {
        previewCalls += 1;
        return {
          ...target,
          text: "• Ran npm test",
          observedAt: 1,
          truncated: false
        };
      },
      focusedTarget: async () => null,
      focus: async () => undefined,
      dispose: () => undefined
    };
    const app = {
      vault: {
        getAbstractFileByPath: () => null
      }
    } as unknown as App;
    const plugin = {
      loadData: async () => undefined,
      saveData: async () => undefined
    } as unknown as Plugin;
    const controller = new AgentCockpitController(app, plugin, async () => new CmuxClient(transport));

    await controller.initialize();
    await controller.waitForBackgroundWork();
    expect({ snapshotCalls, notificationCalls }).toEqual({ snapshotCalls: 1, notificationCalls: 1 });
    expect(previewCalls).toBe(1);
    expect(controller.store.getState().sessions[0]?.provider.provider).toBe("codex");

    await controller.refreshNow();
    expect({ snapshotCalls, notificationCalls }).toEqual({ snapshotCalls: 2, notificationCalls: 2 });
    expect(previewCalls).toBe(1);
    expect(controller.store.getState().sessions[0]?.provider.provider).toBe("codex");
    controller.dispose();
  });

  it("uses deeper bounded evidence without replacing the visible preview", async () => {
    const requests: { lines: number; maxBytes: number }[] = [];
    const shallowText = "Answer body without visible provider chrome.";
    const transport: CmuxTransport = {
      probe: async () => ({
        binaryPath: "/cmux",
        versionText: "cmux 0.62.2",
        capabilities: {
          version: 2,
          protocol: "cmux-socket",
          accessMode: "automation",
          methods: new Set()
        },
        latencyMs: 1
      }),
      snapshot: async () => snapshot(1),
      notifications: async () => [],
      readPreview: async (target, request) => {
        requests.push({ lines: request.lines, maxBytes: request.maxBytes });
        return {
          ...target,
          text: request.lines === 500 ? `${shallowText}\n• Ran npm test` : shallowText,
          observedAt: 1,
          truncated: false
        };
      },
      focusedTarget: async () => null,
      focus: async () => undefined,
      dispose: () => undefined
    };
    const app = {
      vault: {
        getAbstractFileByPath: () => null
      }
    } as unknown as App;
    const plugin = {
      loadData: async () => undefined,
      saveData: async () => undefined
    } as unknown as Plugin;
    const controller = new AgentCockpitController(app, plugin, async () => new CmuxClient(transport));

    await controller.initialize();
    await controller.waitForBackgroundWork();

    expect(requests).toEqual([{ lines: 500, maxBytes: 64 * 1024 }]);
    expect(controller.store.getState().sessions[0]?.provider.provider).toBe("codex");
    expect(controller.store.getState().sessions[0]?.preview).toBeNull();

    await controller.loadPreview(controller.store.getState().sessions[0]!);
    expect(requests).toEqual([
      { lines: 500, maxBytes: 64 * 1024 },
      { lines: 60, maxBytes: 16 * 1024 }
    ]);
    expect(controller.store.getState().sessions[0]?.preview?.text).toBe(shallowText);
    controller.dispose();
  });

  it("re-probes and fully loads the cockpit after access setup succeeds", async () => {
    let clientAttempts = 0;
    let snapshotCalls = 0;
    const transport: CmuxTransport = {
      probe: async () => ({
        binaryPath: "/cmux",
        versionText: "cmux 0.62.2",
        capabilities: {
          version: 2,
          protocol: "cmux-socket",
          accessMode: "password",
          methods: new Set()
        },
        latencyMs: 1
      }),
      snapshot: async () => {
        snapshotCalls += 1;
        return snapshot(2);
      },
      notifications: async () => [],
      readPreview: async (target) => ({
        ...target,
        text: "• Ran npm test",
        observedAt: 2,
        truncated: false
      }),
      focusedTarget: async () => null,
      focus: async () => undefined,
      dispose: () => undefined
    };
    const app = {
      vault: {
        getAbstractFileByPath: () => null
      }
    } as unknown as App;
    const plugin = {
      loadData: async () => undefined,
      saveData: async () => undefined
    } as unknown as Plugin;
    const controller = new AgentCockpitController(app, plugin, async () => {
      clientAttempts += 1;
      if (clientAttempts === 1) {
        throw new CmuxError("access-blocked", "Complete the one-time cmux access setup.");
      }
      return new CmuxClient(transport);
    });

    await controller.initialize();
    expect(controller.store.getState().connection.status).toBe("access-blocked");

    await controller.testConnection();
    await controller.waitForBackgroundWork();

    expect(clientAttempts).toBe(2);
    expect(snapshotCalls).toBe(1);
    expect(controller.store.getState().connection).toMatchObject({
      status: "connected",
      accessMode: "password",
      message: "Connected through cmux Password mode. The socket password remains owned by cmux."
    });
    expect(controller.store.getState().sessions).toHaveLength(1);
    expect(controller.store.getState().sessions[0]?.provider.provider).toBe("codex");
    controller.dispose();
  });

  it("keeps topology connected and marks only notification health stale after a partial refresh failure", async () => {
    let notificationFails = false;
    let observedAt = 0;
    const notification = {
      id: "notice",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      title: "Review",
      subtitle: "",
      body: "Ready for review",
      isRead: false
    };
    const transport: CmuxTransport = {
      probe: async () => ({
        binaryPath: "/cmux",
        versionText: "cmux 0.62.2",
        capabilities: {
          version: 2,
          protocol: "cmux-socket",
          accessMode: "password",
          methods: new Set()
        },
        latencyMs: 1
      }),
      snapshot: async () => snapshot(++observedAt),
      notifications: async () => {
        if (notificationFails) throw new Error("notification parser failed");
        return [notification];
      },
      readPreview: async (target) => ({ ...target, text: "shell", observedAt, truncated: false }),
      focusedTarget: async () => null,
      focus: async () => undefined,
      dispose: () => undefined
    };
    const app = { vault: { getAbstractFileByPath: () => null } } as unknown as App;
    const plugin = {
      loadData: async () => undefined,
      saveData: async () => undefined
    } as unknown as Plugin;
    const controller = new AgentCockpitController(app, plugin, async () => new CmuxClient(transport));

    await controller.initialize();
    await controller.waitForBackgroundWork();
    notificationFails = true;
    await controller.refreshNow();

    expect(controller.store.getState()).toMatchObject({
      connection: { status: "connected" },
      notifications: [notification],
      health: {
        topology: { status: "fresh" },
        notifications: { status: "stale" },
        lifecycle: { status: "unavailable" }
      }
    });
    controller.dispose();
  });
});
