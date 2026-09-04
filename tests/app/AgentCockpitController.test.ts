import { Notice, type App, type Plugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { AgentCockpitController } from "../../src/app/AgentCockpitController";
import { BindingRepository } from "../../src/bindings/BindingRepository";
import { CmuxClient } from "../../src/cmux/CmuxClient";
import type { CmuxTransport } from "../../src/cmux/CmuxTransport";
import { CmuxError, type CmuxSnapshot } from "../../src/cmux/types";
import { ProviderMetadataService } from "../../src/providers/ProviderMetadataService";
import type {
  ProviderIdentityResolution,
  ProviderSessionResolver
} from "../../src/providers/identity/types";
import type { ProviderSessionMetadata, ProviderSessionSource } from "../../src/providers/types";
import { TaskRepository } from "../../src/tasks/TaskRepository";
import { automaticTaskId } from "../../src/tracking/AutomaticTaskTracking";
import { createMemoryTaskApp as memoryTaskApp } from "../helpers/memoryTaskApp";

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

function exactCodexResolverResult(observedAt: number): ProviderIdentityResolution {
  return {
    checkedAt: observedAt + 1,
    nativeLifecycleAvailable: false,
    issues: [],
    mappings: [
      {
        workspaceId: "22222222-2222-4222-8222-222222222222",
        paneId: "33333333-3333-4333-8333-333333333333",
        surfaceId: "44444444-4444-4444-8444-444444444444",
        provider: "codex",
        providerSessionId: "55555555-5555-4555-8555-555555555555",
        matchSource: "codex-writer-lock",
        confidence: "high",
        explanation: "Verified exact writer identity.",
        observedAt: observedAt + 1
      }
    ],
    lifecycle: []
  };
}

function exactCodexResolver(): ProviderSessionResolver {
  return {
    resolve: async (currentSnapshot) => exactCodexResolverResult(currentSnapshot.observedAt),
    dispose: () => undefined
  };
}

function connectedTransport(observedAt: number): CmuxTransport {
  return {
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
    snapshot: async () => snapshot(observedAt),
    notifications: async () => [],
    readPreview: async (target) => ({ ...target, text: "", observedAt, truncated: false }),
    focusedTarget: async () => null,
    focus: async () => undefined,
    dispose: () => undefined
  };
}

function emptyCodexMetadataSource(): ProviderSessionSource {
  return {
    provider: "codex",
    list: async () => [],
    get: async () => null,
    dispose: () => undefined
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

  it("reports an unavailable focus action without rejecting the UI callback", async () => {
    let clientCreations = 0;
    let focusCalls = 0;
    const transport: CmuxTransport = {
      ...connectedTransport(1_050),
      focus: async () => {
        focusCalls += 1;
      }
    };
    const plugin = {
      loadData: async () => ({ settings: { autoTrackAgentRuns: false } }),
      saveData: async () => undefined
    } as unknown as Plugin;
    const notices = (Notice as unknown as { messages: string[] }).messages;
    const noticeStart = notices.length;
    const controller = new AgentCockpitController(
      memoryTaskApp().app,
      plugin,
      async () => {
        clientCreations += 1;
        if (clientCreations > 1) {
          throw new CmuxError("cmux-not-running", "cmux is not running.");
        }
        return new CmuxClient(transport);
      }
    );

    await controller.initialize();
    const session = controller.store.getState().sessions[0]!;
    await controller.testConnection();

    await expect(controller.focusSession(session)).resolves.toBeUndefined();
    expect(focusCalls).toBe(0);
    expect(notices.slice(noticeStart)).toContain("cmux connection is not initialized.");
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

  it("restores a persisted exact conversation match and loads its title read-only", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    await repository.mapProviderSession({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex",
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      matchedAt: "2026-09-02T00:00:00.000Z"
    });
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [
        {
          provider: "codex",
          sessionId: "55555555-5555-4555-8555-555555555555",
          title: "Fix Flight Detail timeout handling",
          titleSource: "explicit-name",
          cwd: "/repository",
          updatedAt: 1_000,
          status: "idle"
        }
      ],
      get: async () => null,
      dispose: () => undefined
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
      snapshot: async () => snapshot(1_000),
      notifications: async () => [],
      readPreview: async (target) => ({ ...target, text: "", observedAt: 1_000, truncated: false }),
      focusedTarget: async () => null,
      focus: async () => undefined,
      dispose: () => undefined
    };
    const app = { vault: { getAbstractFileByPath: () => null } } as unknown as App;
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(transport),
      new ProviderMetadataService([source])
    );

    await controller.initialize();
    await controller.waitForBackgroundWork();

    expect(controller.store.getState().sessions[0]).toMatchObject({
      provider: {
        provider: "codex",
        source: "provider-session-mapping",
        sessionId: "55555555-5555-4555-8555-555555555555"
      },
      conversation: {
        title: "Fix Flight Detail timeout handling",
        matchSource: "manual",
        matchConfidence: "high"
      }
    });
    controller.dispose();
  });

  it("projects an automatic exact conversation title and lifecycle without persisting the match", async () => {
    let saved = false;
    const plugin = {
      loadData: async () => ({ settings: { autoTrackAgentRuns: false } }),
      saveData: async () => {
        saved = true;
      }
    } as unknown as Plugin;
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [
        {
          provider: "codex",
          sessionId: "55555555-5555-4555-8555-555555555555",
          title: "Implement plug-and-play conversation identity",
          titleSource: "explicit-name",
          cwd: "/repository",
          updatedAt: 1_000,
          status: "idle",
          parentSessionId: null,
          sourceKind: "cli"
        }
      ],
      get: async () => null,
      dispose: () => undefined
    };
    const resolver: ProviderSessionResolver = {
      resolve: async () => ({
        checkedAt: 1_100,
        nativeLifecycleAvailable: true,
        issues: [],
        mappings: [
          {
            workspaceId: "22222222-2222-4222-8222-222222222222",
            paneId: "33333333-3333-4333-8333-333333333333",
            surfaceId: "44444444-4444-4444-8444-444444444444",
            provider: "codex",
            providerSessionId: "55555555-5555-4555-8555-555555555555",
            matchSource: "codex-writer-lock",
            confidence: "high",
            explanation: "Verified exact writer identity.",
            observedAt: 1_100
          }
        ],
        lifecycle: [
          {
            workspaceId: "22222222-2222-4222-8222-222222222222",
            paneId: "33333333-3333-4333-8333-333333333333",
            surfaceId: "44444444-4444-4444-8444-444444444444",
            state: "idle",
            source: "hook",
            provider: "codex",
            providerSessionId: "55555555-5555-4555-8555-555555555555",
            observedAt: 1_100,
            occurredAt: 1_050,
            explanation: "cmux reports idle."
          }
        ]
      }),
      dispose: () => undefined
    };
    const transport: CmuxTransport = {
      probe: async () => ({
        binaryPath: "/cmux",
        versionText: "cmux future",
        capabilities: {
          version: 6,
          protocol: "cmux-socket",
          accessMode: "password",
          methods: new Set()
        },
        latencyMs: 1
      }),
      snapshot: async () => snapshot(1_000),
      notifications: async () => [],
      readPreview: async (target) => ({ ...target, text: "", observedAt: 1_000, truncated: false }),
      focusedTarget: async () => null,
      focus: async () => undefined,
      dispose: () => undefined
    };
    const { app, markdownWrites } = memoryTaskApp();
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(transport),
      new ProviderMetadataService([source]),
      resolver
    );

    await controller.initialize();
    await controller.waitForBackgroundWork();

    expect(controller.store.getState().sessions[0]).toMatchObject({
      provider: {
        provider: "codex",
        source: "codex-writer-lock",
        sessionId: "55555555-5555-4555-8555-555555555555"
      },
      conversation: {
        title: "Implement plug-and-play conversation identity",
        matchSource: "codex-writer-lock"
      },
      assessment: {
        executionPhase: "idle",
        coverage: "structured"
      }
    });
    expect(controller.store.getState().health.lifecycle.status).toBe("fresh");
    expect(saved).toBe(false);
    expect(markdownWrites).toEqual([]);
    expect(controller.store.getState().tasks).toEqual([]);
    controller.dispose();
  });

  it("recomputes conservative stale-working attention from the configured threshold", async () => {
    let persisted: unknown = {
      settings: {
        autoTrackAgentRuns: false,
        staleAfterMs: 5 * 60_000
      }
    };
    const now = Date.now();
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const resolver: ProviderSessionResolver = {
      resolve: async () => ({
        checkedAt: now,
        nativeLifecycleAvailable: true,
        issues: [],
        mappings: [
          {
            workspaceId: "22222222-2222-4222-8222-222222222222",
            paneId: "33333333-3333-4333-8333-333333333333",
            surfaceId: "44444444-4444-4444-8444-444444444444",
            provider: "codex",
            providerSessionId: "55555555-5555-4555-8555-555555555555",
            matchSource: "cmux-agent-registry",
            confidence: "high",
            explanation: "Verified exact native identity.",
            observedAt: now
          }
        ],
        lifecycle: [
          {
            workspaceId: "22222222-2222-4222-8222-222222222222",
            paneId: "33333333-3333-4333-8333-333333333333",
            surfaceId: "44444444-4444-4444-8444-444444444444",
            state: "working",
            source: "hook",
            provider: "codex",
            providerSessionId: "55555555-5555-4555-8555-555555555555",
            observedAt: now,
            occurredAt: now - 10 * 60_000,
            explanation: "cmux still reports working."
          }
        ]
      }),
      dispose: () => undefined
    };
    const { app } = memoryTaskApp();
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(connectedTransport(now)),
      new ProviderMetadataService([emptyCodexMetadataSource()]),
      resolver
    );

    await controller.initialize();
    await controller.waitForBackgroundWork();

    expect(controller.store.getState().attention).toMatchObject([
      {
        reasons: [{ kind: "stale", confidence: "medium" }],
        session: { assessment: { executionPhase: "working", coverage: "structured" } }
      }
    ]);

    await controller.updateSettings({
      ...controller.getSettings(),
      staleAfterMs: 24 * 60 * 60_000
    });

    expect(controller.store.getState().attention).toEqual([]);
    expect(controller.store.getState().tasks).toEqual([]);
    controller.dispose();
  });

  it("reports whether a workflow move persisted so rejected controls can roll back", async () => {
    const plugin = {
      loadData: async () => ({ settings: { autoTrackAgentRuns: false } }),
      saveData: async () => undefined
    } as unknown as Plugin;
    const { app } = memoryTaskApp({ failFrontmatterWrites: 1 });
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(connectedTransport(Date.now()))
    );

    await controller.initialize();
    const task = await controller.createTask({ title: "Workflow result" });

    await expect(controller.updateWorkflow(task, "review")).resolves.toBe(false);
    expect(controller.store.getState().tasks).toMatchObject([
      { taskId: task.taskId, workflowStatus: "active" }
    ]);

    await expect(controller.updateWorkflow(task, "review")).resolves.toBe(true);
    expect(controller.store.getState().tasks).toMatchObject([
      { taskId: task.taskId, workflowStatus: "review" }
    ]);
    controller.dispose();
  });

  it("automatically creates one neutral active task for an exact session and never recreates it", async () => {
    let persisted: unknown;
    let observedAt = 1_000;
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [
        {
          provider: "codex",
          sessionId: "55555555-5555-4555-8555-555555555555",
          title: "Private: repair the production payment pipeline",
          titleSource: "explicit-name",
          cwd: "/repository",
          updatedAt: 1_000,
          status: "active"
        }
      ],
      get: async () => null,
      dispose: () => undefined
    };
    const createResolver = (): ProviderSessionResolver => ({
      resolve: async (currentSnapshot) => ({
        checkedAt: currentSnapshot.observedAt + 1,
        nativeLifecycleAvailable: false,
        issues: [],
        mappings: [
          {
            workspaceId: "22222222-2222-4222-8222-222222222222",
            paneId: "33333333-3333-4333-8333-333333333333",
            surfaceId: "44444444-4444-4444-8444-444444444444",
            provider: "codex",
            providerSessionId: "55555555-5555-4555-8555-555555555555",
            matchSource: "codex-writer-lock",
            confidence: "high",
            explanation: "Verified exact writer identity.",
            observedAt: currentSnapshot.observedAt + 1
          }
        ],
        lifecycle: []
      }),
      dispose: () => undefined
    });
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
      notifications: async () => [],
      readPreview: async (target) => ({ ...target, text: "", observedAt, truncated: false }),
      focusedTarget: async () => null,
      focus: async () => undefined,
      dispose: () => undefined
    };
    const { app, markdownWrites } = memoryTaskApp();
    const createController = (): AgentCockpitController =>
      new AgentCockpitController(
        app,
        plugin,
        async () => new CmuxClient(transport),
        new ProviderMetadataService([source]),
        createResolver()
      );
    let controller = createController();

    await controller.initialize();
    await controller.waitForBackgroundWork();

    expect(controller.store.getState().tasks).toMatchObject([
      {
        title: "Codex run · repository",
        workflowStatus: "active",
        repository: "/repository",
        runCount: 1
      }
    ]);
    expect(controller.store.getState().bindings).toMatchObject([
      {
        provider: "codex",
        providerSessionId: "55555555-5555-4555-8555-555555555555"
      }
    ]);
    expect(controller.store.getState().runs).toHaveLength(1);
    expect(markdownWrites).toHaveLength(1);
    expect(markdownWrites[0]).not.toContain("Private: repair the production payment pipeline");
    expect(JSON.stringify(persisted)).not.toContain("Private: repair the production payment pipeline");
    expect(controller.store.getState().sessions[0]?.conversation?.title).toBe(
      "Private: repair the production payment pipeline"
    );

    await controller.refreshNow();
    await controller.waitForBackgroundWork();
    expect(controller.store.getState().tasks).toHaveLength(1);
    expect(controller.store.getState().bindings).toHaveLength(1);
    expect(controller.store.getState().runs).toHaveLength(1);
    expect(markdownWrites).toHaveLength(1);

    controller.dispose();
    controller = createController();
    await controller.initialize();
    await controller.waitForBackgroundWork();
    expect(controller.store.getState().tasks).toHaveLength(1);
    expect(controller.store.getState().bindings).toHaveLength(1);
    expect(controller.store.getState().runs).toHaveLength(1);
    expect(markdownWrites).toHaveLength(1);

    const task = controller.store.getState().tasks[0]!;
    await controller.updateWorkflow(task, "done");
    await controller.detachTask(controller.store.getState().sessions[0]!);
    await controller.refreshNow();
    await controller.waitForBackgroundWork();

    expect(controller.store.getState().tasks).toMatchObject([
      { taskId: task.taskId, workflowStatus: "done", runCount: 1 }
    ]);
    expect(controller.store.getState().bindings).toEqual([]);
    expect(controller.store.getState().runs).toHaveLength(1);
    expect(markdownWrites).toHaveLength(1);

    controller.dispose();
    controller = createController();
    await controller.initialize();
    await controller.waitForBackgroundWork();
    expect(controller.store.getState().tasks).toMatchObject([
      { taskId: task.taskId, workflowStatus: "done", runCount: 1 }
    ]);
    expect(controller.store.getState().bindings).toEqual([]);
    expect(controller.store.getState().runs).toHaveLength(1);
    expect(markdownWrites).toHaveLength(1);
    controller.dispose();
  });

  it("starts a new automatic task when a different exact session reuses the same surface", async () => {
    let persisted: unknown;
    let observedAt = 1_500;
    let providerSessionId = "55555555-5555-4555-8555-555555555555";
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const resolver: ProviderSessionResolver = {
      resolve: async (currentSnapshot) => ({
        ...exactCodexResolverResult(currentSnapshot.observedAt),
        mappings: [
          {
            ...exactCodexResolverResult(currentSnapshot.observedAt).mappings[0]!,
            providerSessionId
          }
        ]
      }),
      dispose: () => undefined
    };
    const transport: CmuxTransport = {
      ...connectedTransport(observedAt),
      snapshot: async () => snapshot(++observedAt)
    };
    const { app, markdownWrites } = memoryTaskApp();
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(transport),
      new ProviderMetadataService([emptyCodexMetadataSource()]),
      resolver
    );

    await controller.initialize();
    await controller.waitForBackgroundWork();
    const firstTaskId = automaticTaskId("codex", providerSessionId);
    expect(controller.store.getState().sessions[0]?.linkedTaskId).toBe(firstTaskId);

    providerSessionId = "66666666-6666-4666-8666-666666666666";
    await controller.refreshNow();
    await controller.waitForBackgroundWork();

    const secondTaskId = automaticTaskId("codex", providerSessionId);
    expect(markdownWrites).toHaveLength(2);
    expect(controller.store.getState().tasks).toHaveLength(2);
    expect(controller.store.getState().tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: firstTaskId, runCount: 1 }),
        expect.objectContaining({ taskId: secondTaskId, runCount: 1 })
      ])
    );
    expect(controller.store.getState().bindings).toMatchObject([
      {
        taskId: secondTaskId,
        provider: "codex",
        providerSessionId
      }
    ]);
    expect(controller.store.getState().runs).toHaveLength(2);
    expect(controller.store.getState().sessions[0]?.linkedTaskId).toBe(secondTaskId);
    controller.dispose();
  });

  it("reconnects an exact provider conversation to its existing task after its surface changes", async () => {
    let persisted: unknown;
    let currentSnapshot = snapshot(2_000);
    let resolvedSurfaceId: string | null = null;
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const resolver: ProviderSessionResolver = {
      resolve: async (nextSnapshot) => {
        const workspace = nextSnapshot.windows[0]!.workspaces[0]!;
        const pane = workspace.panes[0]!;
        const surface = resolvedSurfaceId === null
          ? pane.surfaces[0]!
          : pane.surfaces.find((candidate) => candidate.id === resolvedSurfaceId)!;
        return {
          checkedAt: nextSnapshot.observedAt + 1,
          nativeLifecycleAvailable: false,
          issues: [],
          mappings: [
            {
              workspaceId: workspace.id,
              paneId: pane.id,
              surfaceId: surface.id,
              provider: "codex",
              providerSessionId: "55555555-5555-4555-8555-555555555555",
              matchSource: "codex-writer-lock",
              confidence: "high",
              explanation: "Verified exact writer identity.",
              observedAt: nextSnapshot.observedAt + 1
            }
          ],
          lifecycle: []
        };
      },
      dispose: () => undefined
    };
    const transport: CmuxTransport = {
      ...connectedTransport(2_000),
      snapshot: async () => structuredClone(currentSnapshot)
    };
    const { app, markdownWrites } = memoryTaskApp();
    const notices = (Notice as unknown as { messages: string[] }).messages;
    const noticeStart = notices.length;
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(transport),
      new ProviderMetadataService([emptyCodexMetadataSource()]),
      resolver
    );

    await controller.initialize();
    await controller.waitForBackgroundWork();
    const originalBinding = controller.store.getState().bindings[0]!;
    const originalRun = controller.store.getState().runs[0]!;
    expect(markdownWrites).toHaveLength(1);

    currentSnapshot = snapshot(2_100);
    const workspace = currentSnapshot.windows[0]!.workspaces[0]!;
    const pane = workspace.panes[0]!;
    const surface = pane.surfaces[0]!;
    workspace.id = "66666666-6666-4666-8666-666666666666";
    currentSnapshot.windows[0]!.selectedWorkspaceId = workspace.id;
    pane.id = "77777777-7777-4777-8777-777777777777";
    pane.selectedSurfaceId = "88888888-8888-4888-8888-888888888888";
    surface.id = pane.selectedSurfaceId;
    surface.paneId = pane.id;

    await controller.refreshNow();
    await controller.waitForBackgroundWork();

    expect(controller.store.getState().tasks).toHaveLength(1);
    expect(markdownWrites).toHaveLength(1);
    expect(controller.store.getState().bindings).toMatchObject([
      {
        bindingId: originalBinding.bindingId,
        runId: originalBinding.runId,
        taskId: originalBinding.taskId,
        workspaceId: workspace.id,
        paneId: pane.id,
        surfaceId: surface.id
      }
    ]);
    expect(controller.store.getState().runs).toMatchObject([
      {
        runId: originalRun.runId,
        taskId: originalRun.taskId,
        firstAttachedAt: originalRun.firstAttachedAt
      }
    ]);
    expect(controller.store.getState().tasks[0]?.runCount).toBe(1);
    expect(controller.store.getState().sessions[0]?.linkedTaskId).toBe(originalBinding.taskId);
    expect(
      controller.store.getState().attention.some((item) =>
        item.reasons.some((reason) => reason.kind === "linked-surface-missing")
      )
    ).toBe(false);
    expect(notices.slice(noticeStart)).toContain(
      "Reconnected 1 exact agent run to existing Work task."
    );

    const resumedSurfaceId = "99999999-9999-4999-8999-999999999999";
    pane.surfaces.push({
      id: resumedSurfaceId,
      paneId: pane.id,
      index: 1,
      indexInPane: 1,
      title: "repository resumed",
      type: "terminal",
      selected: true,
      focused: true,
      active: true
    });
    surface.selected = false;
    surface.focused = false;
    pane.selectedSurfaceId = resumedSurfaceId;
    resolvedSurfaceId = resumedSurfaceId;
    currentSnapshot.observedAt = 2_200;

    await controller.refreshNow();
    await controller.waitForBackgroundWork();

    expect(controller.store.getState().bindings).toMatchObject([
      {
        bindingId: originalBinding.bindingId,
        runId: originalBinding.runId,
        surfaceId: surface.id
      }
    ]);
    expect(controller.store.getState().tasks).toHaveLength(1);
    expect(controller.store.getState().runs).toHaveLength(1);
    expect(
      notices
        .slice(noticeStart)
        .filter((message) => message === "Reconnected 1 exact agent run to existing Work task.")
    ).toHaveLength(1);

    pane.surfaces = pane.surfaces.filter((candidate) => candidate.id === resumedSurfaceId);
    currentSnapshot.observedAt = 2_300;

    await controller.refreshNow();
    await controller.waitForBackgroundWork();

    expect(controller.store.getState().bindings).toMatchObject([
      {
        bindingId: originalBinding.bindingId,
        runId: originalBinding.runId,
        surfaceId: resumedSurfaceId
      }
    ]);
    expect(controller.store.getState().tasks).toHaveLength(1);
    expect(controller.store.getState().tasks[0]?.runCount).toBe(1);
    expect(controller.store.getState().runs).toHaveLength(1);
    expect(
      notices
        .slice(noticeStart)
        .filter((message) => message === "Reconnected 1 exact agent run to existing Work task.")
    ).toHaveLength(2);
    controller.dispose();
  });

  it("tracks an exact session before optional provider-title metadata finishes loading", async () => {
    let persisted: unknown;
    let finishMetadata: ((sessions: []) => void) | undefined;
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => new Promise<[]>((resolve) => {
        finishMetadata = resolve;
      }),
      get: async () => null,
      dispose: () => undefined
    };
    const resolver: ProviderSessionResolver = {
      resolve: async (currentSnapshot) => ({
        checkedAt: currentSnapshot.observedAt + 1,
        nativeLifecycleAvailable: false,
        issues: [],
        mappings: [
          {
            workspaceId: "22222222-2222-4222-8222-222222222222",
            paneId: "33333333-3333-4333-8333-333333333333",
            surfaceId: "44444444-4444-4444-8444-444444444444",
            provider: "codex",
            providerSessionId: "55555555-5555-4555-8555-555555555555",
            matchSource: "codex-writer-lock",
            confidence: "high",
            explanation: "Verified exact writer identity.",
            observedAt: currentSnapshot.observedAt + 1
          }
        ],
        lifecycle: []
      }),
      dispose: () => undefined
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
      snapshot: async () => snapshot(3_000),
      notifications: async () => [],
      readPreview: async (target) => ({ ...target, text: "", observedAt: 3_000, truncated: false }),
      focusedTarget: async () => null,
      focus: async () => undefined,
      dispose: () => undefined
    };
    const { app, markdownWrites } = memoryTaskApp();
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(transport),
      new ProviderMetadataService([source]),
      resolver
    );

    await controller.initialize();
    await vi.waitFor(() => {
      expect(controller.store.getState().tasks).toHaveLength(1);
      expect(controller.store.getState().bindings).toHaveLength(1);
    });
    expect(markdownWrites).toHaveLength(1);

    finishMetadata?.([]);
    await controller.waitForBackgroundWork();
    controller.dispose();
  });

  it("repairs a tracked automatic task after a transient run-count write failure", async () => {
    let persisted: unknown;
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [],
      get: async () => null,
      dispose: () => undefined
    };
    const resolver: ProviderSessionResolver = {
      resolve: async (currentSnapshot) => ({
        checkedAt: currentSnapshot.observedAt + 1,
        nativeLifecycleAvailable: false,
        issues: [],
        mappings: [
          {
            workspaceId: "22222222-2222-4222-8222-222222222222",
            paneId: "33333333-3333-4333-8333-333333333333",
            surfaceId: "44444444-4444-4444-8444-444444444444",
            provider: "codex",
            providerSessionId: "55555555-5555-4555-8555-555555555555",
            matchSource: "codex-writer-lock",
            confidence: "high",
            explanation: "Verified exact writer identity.",
            observedAt: currentSnapshot.observedAt + 1
          }
        ],
        lifecycle: []
      }),
      dispose: () => undefined
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
      snapshot: async () => snapshot(4_000),
      notifications: async () => [],
      readPreview: async (target) => ({ ...target, text: "", observedAt: 4_000, truncated: false }),
      focusedTarget: async () => null,
      focus: async () => undefined,
      dispose: () => undefined
    };
    const { app, markdownWrites } = memoryTaskApp({ failFrontmatterWrites: 1 });
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(transport),
      new ProviderMetadataService([source]),
      resolver
    );

    await controller.initialize();
    await controller.waitForBackgroundWork();

    expect(markdownWrites).toHaveLength(1);
    expect(controller.store.getState().tasks).toMatchObject([{ runCount: 1 }]);
    expect(controller.store.getState().bindings).toHaveLength(1);
    expect(controller.store.getState().runs).toHaveLength(1);
    controller.dispose();
  });

  it("reports a persistent automatic run-count failure only once while retries continue", async () => {
    let persisted: unknown;
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const notices = (Notice as unknown as { messages: string[] }).messages;
    notices.length = 0;
    const { app, frontmatterWriteAttempts } = memoryTaskApp({ failFrontmatterWrites: 100 });
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(connectedTransport(4_100)),
      new ProviderMetadataService([emptyCodexMetadataSource()]),
      exactCodexResolver()
    );

    try {
      await controller.initialize();
      await controller.waitForBackgroundWork();
      await controller.refreshNow();
      await controller.waitForBackgroundWork();

      expect(controller.store.getState().tasks).toMatchObject([{ runCount: 0 }]);
      expect(controller.store.getState().bindings).toHaveLength(1);
      expect(frontmatterWriteAttempts()).toBeGreaterThan(1);
      expect(
        notices.filter((message) =>
          message.startsWith(
            "Automatic task tracking could not finish: The automatic task run count"
          )
        )
      ).toHaveLength(1);
    } finally {
      controller.dispose();
      notices.length = 0;
    }
  });

  it("reports a recurring automatic tracking failure again after a successful reconciliation", async () => {
    let persisted: unknown;
    let failTaskLookup = false;
    let releaseIdentity: (() => void) | undefined;
    const identityGate = new Promise<void>((resolve) => {
      releaseIdentity = resolve;
    });
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const resolver: ProviderSessionResolver = {
      resolve: async (currentSnapshot) => {
        await identityGate;
        return exactCodexResolverResult(currentSnapshot.observedAt);
      },
      dispose: () => undefined
    };
    const notices = (Notice as unknown as { messages: string[] }).messages;
    notices.length = 0;
    const { app } = memoryTaskApp({
      beforeLookup: (path) => {
        if (failTaskLookup && path === "Agent Cockpit/Tasks") {
          throw new Error("simulated task enumeration failure");
        }
      }
    });
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(connectedTransport(4_200)),
      new ProviderMetadataService([emptyCodexMetadataSource()]),
      resolver
    );

    try {
      await controller.initialize();
      failTaskLookup = true;
      releaseIdentity?.();
      await controller.waitForBackgroundWork();

      failTaskLookup = false;
      await controller.refreshNow();
      await controller.waitForBackgroundWork();
      expect(controller.store.getState().tasks).toHaveLength(1);

      failTaskLookup = true;
      await controller.refreshNow();
      await controller.waitForBackgroundWork();

      expect(
        notices.filter((message) =>
          message.endsWith("simulated task enumeration failure")
        )
      ).toHaveLength(2);
    } finally {
      controller.dispose();
      notices.length = 0;
    }
  });

  it("coalesces the same automatic tracking failure across sessions in one reconciliation", async () => {
    let persisted: unknown;
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const currentSnapshot = snapshot(4_300);
    const workspace = currentSnapshot.windows[0]!.workspaces[0]!;
    const pane = workspace.panes[0]!;
    pane.surfaces.push({
      ...pane.surfaces[0]!,
      id: "66666666-6666-4666-8666-666666666666",
      index: 1,
      indexInPane: 1,
      title: "second repository session",
      selected: false,
      focused: false
    });
    const resolver: ProviderSessionResolver = {
      resolve: async (nextSnapshot) => ({
        checkedAt: nextSnapshot.observedAt + 1,
        nativeLifecycleAvailable: false,
        issues: [],
        mappings: [
          ...exactCodexResolverResult(nextSnapshot.observedAt).mappings,
          {
            workspaceId: workspace.id,
            paneId: pane.id,
            surfaceId: "66666666-6666-4666-8666-666666666666",
            provider: "codex",
            providerSessionId: "77777777-7777-4777-8777-777777777777",
            matchSource: "codex-writer-lock",
            confidence: "high",
            explanation: "Verified second exact writer identity.",
            observedAt: nextSnapshot.observedAt + 1
          }
        ],
        lifecycle: []
      }),
      dispose: () => undefined
    };
    const transport: CmuxTransport = {
      ...connectedTransport(4_300),
      snapshot: async () => currentSnapshot
    };
    const notices = (Notice as unknown as { messages: string[] }).messages;
    notices.length = 0;
    const { app } = memoryTaskApp({
      beforeCreate: async () => {
        throw new Error("simulated shared task creation failure");
      }
    });
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(transport),
      new ProviderMetadataService([emptyCodexMetadataSource()]),
      resolver
    );

    try {
      await controller.initialize();
      await controller.waitForBackgroundWork();

      expect(
        controller.store
          .getState()
          .sessions.filter((session) => session.provider.confidence === "high")
      ).toHaveLength(2);
      expect(
        notices.filter((message) =>
          message.endsWith("simulated shared task creation failure")
        )
      ).toHaveLength(1);
    } finally {
      controller.dispose();
      notices.length = 0;
    }
  });

  it("reports a tracking failure again when the failed session disappears and returns", async () => {
    let persisted: unknown;
    let currentSnapshot = snapshot(4_400);
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const transport: CmuxTransport = {
      ...connectedTransport(4_400),
      snapshot: async () => currentSnapshot
    };
    const notices = (Notice as unknown as { messages: string[] }).messages;
    notices.length = 0;
    const { app } = memoryTaskApp({
      beforeCreate: async () => {
        throw new Error("simulated returning-session task failure");
      }
    });
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(transport),
      new ProviderMetadataService([emptyCodexMetadataSource()]),
      exactCodexResolver()
    );
    const matchingNotices = (): string[] =>
      notices.filter((message) =>
        message.endsWith("simulated returning-session task failure")
      );

    try {
      await controller.initialize();
      await controller.waitForBackgroundWork();
      expect(matchingNotices()).toHaveLength(1);

      currentSnapshot = snapshot(4_500);
      currentSnapshot.windows[0]!.workspaces[0]!.panes[0]!.surfaces = [];
      await controller.refreshNow();
      await controller.waitForBackgroundWork();

      currentSnapshot = snapshot(4_600);
      await controller.refreshNow();
      await controller.waitForBackgroundWork();
      expect(matchingNotices()).toHaveLength(2);
    } finally {
      controller.dispose();
      notices.length = 0;
    }
  });

  it("cancels stale automatic tracking work as soon as the user opts out", async () => {
    let persisted: unknown;
    let releaseCreate: (() => void) | undefined;
    let markCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const resolver = exactCodexResolver();
    const transport = connectedTransport(4_500);
    const source = emptyCodexMetadataSource();
    const { app, markdownWrites } = memoryTaskApp({
      beforeCreate: async () => {
        markCreateStarted?.();
        await createGate;
      }
    });
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(transport),
      new ProviderMetadataService([source]),
      resolver
    );

    await controller.initialize();
    await createStarted;
    await controller.updateSettings({
      ...controller.getSettings(),
      autoTrackAgentRuns: false
    });
    releaseCreate?.();
    await controller.waitForBackgroundWork();

    // A vault.create call that has already started cannot be aborted safely,
    // but stale work must stop before it attaches the live provider session.
    expect(markdownWrites).toHaveLength(1);
    expect(controller.getSettings().autoTrackAgentRuns).toBe(false);
    expect(controller.store.getState().bindings).toEqual([]);
    expect(controller.store.getState().runs).toEqual([]);

    await controller.refreshNow();
    await controller.waitForBackgroundWork();
    expect(markdownWrites).toHaveLength(1);
    expect(controller.store.getState().bindings).toEqual([]);
    expect(controller.store.getState().runs).toEqual([]);
    controller.dispose();
  });

  it("keeps a concurrent explicit task attachment instead of replacing it automatically", async () => {
    let persisted: unknown;
    let gateAutomaticCreate = false;
    let releaseAutomaticCreate: (() => void) | undefined;
    let markAutomaticCreateStarted: (() => void) | undefined;
    const automaticCreateStarted = new Promise<void>((resolve) => {
      markAutomaticCreateStarted = resolve;
    });
    const automaticCreateGate = new Promise<void>((resolve) => {
      releaseAutomaticCreate = resolve;
    });
    let releaseFirstSave: (() => void) | undefined;
    let markFirstSaveStarted: (() => void) | undefined;
    const firstSaveStarted = new Promise<void>((resolve) => {
      markFirstSaveStarted = resolve;
    });
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let saveCount = 0;
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        saveCount += 1;
        if (saveCount === 1) {
          markFirstSaveStarted?.();
          await firstSaveGate;
        }
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const { app, markdownWrites } = memoryTaskApp({
      beforeCreate: async () => {
        if (!gateAutomaticCreate) return;
        markAutomaticCreateStarted?.();
        await automaticCreateGate;
      }
    });
    const manualTask = await new TaskRepository(app, "Agent Cockpit/Tasks").create({
      title: "User-selected task"
    });
    gateAutomaticCreate = true;
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(connectedTransport(4_450)),
      new ProviderMetadataService([emptyCodexMetadataSource()]),
      exactCodexResolver()
    );

    await controller.initialize();
    await automaticCreateStarted;
    const manualAttachment = controller.attachTask(
      controller.store.getState().sessions[0]!,
      manualTask
    );
    await firstSaveStarted;
    releaseAutomaticCreate?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFirstSave?.();
    await manualAttachment;
    await controller.waitForBackgroundWork();

    expect(controller.store.getState().bindings).toMatchObject([
      { taskId: manualTask.taskId }
    ]);
    expect(controller.store.getState().runs).toMatchObject([
      { taskId: manualTask.taskId, provider: "codex" }
    ]);
    expect(controller.store.getState().runs).toHaveLength(1);
    expect(controller.store.getState().sessions[0]?.linkedTaskId).toBe(manualTask.taskId);
    expect(controller.store.getState().tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: manualTask.taskId, runCount: 1 }),
        expect.objectContaining({
          taskId: automaticTaskId("codex", "55555555-5555-4555-8555-555555555555"),
          runCount: 0
        })
      ])
    );
    expect(markdownWrites).toHaveLength(2);
    controller.dispose();
  });

  it("restores automatic tracking without duplication when saving an opt-out fails", async () => {
    let persisted: unknown;
    let saveAttempts = 0;
    let releaseCreate: (() => void) | undefined;
    let markCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        saveAttempts += 1;
        if (saveAttempts === 1) throw new Error("simulated settings write failure");
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const { app, markdownWrites } = memoryTaskApp({
      beforeCreate: async () => {
        markCreateStarted?.();
        await createGate;
      }
    });
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(connectedTransport(4_600)),
      new ProviderMetadataService([emptyCodexMetadataSource()]),
      exactCodexResolver()
    );

    await controller.initialize();
    await createStarted;
    await expect(
      controller.updateSettings({
        ...controller.getSettings(),
        autoTrackAgentRuns: false
      })
    ).rejects.toThrow("simulated settings write failure");
    expect(controller.getSettings().autoTrackAgentRuns).toBe(true);

    releaseCreate?.();
    await controller.waitForBackgroundWork();

    expect(saveAttempts).toBe(2);
    expect(markdownWrites).toHaveLength(1);
    expect(controller.store.getState().tasks).toMatchObject([{ runCount: 1 }]);
    expect(controller.store.getState().bindings).toHaveLength(1);
    expect(controller.store.getState().runs).toHaveLength(1);
    controller.dispose();
  });

  it("reconciles into the new task folder without binding stale queued work", async () => {
    let persisted: unknown;
    let releaseCreate: (() => void) | undefined;
    let markCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const { app, markdownWrites, createdPaths } = memoryTaskApp({
      beforeCreate: async () => {
        markCreateStarted?.();
        await createGate;
      }
    });
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(connectedTransport(4_700)),
      new ProviderMetadataService([emptyCodexMetadataSource()]),
      exactCodexResolver()
    );

    await controller.initialize();
    await createStarted;
    await controller.updateSettings({
      ...controller.getSettings(),
      taskFolder: "New Agent Tasks"
    });
    releaseCreate?.();
    await controller.waitForBackgroundWork();

    expect(markdownWrites).toHaveLength(2);
    expect(createdPaths[0]).toMatch(/^Agent Cockpit\/Tasks\//);
    expect(createdPaths[1]).toMatch(/^New Agent Tasks\//);
    expect(controller.store.getState().tasks).toMatchObject([
      { file: { path: createdPaths[1] }, runCount: 1 }
    ]);
    expect(controller.store.getState().bindings).toHaveLength(1);
    expect(controller.store.getState().runs).toHaveLength(1);
    controller.dispose();
  });

  it("refreshes reconfigured cmux topology before automatic tracking resumes", async () => {
    let persisted: unknown;
    const requestedBinaryPaths: string[] = [];
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const resolver: ProviderSessionResolver = {
      resolve: async (currentSnapshot) => ({
        checkedAt: currentSnapshot.observedAt + 1,
        nativeLifecycleAvailable: false,
        issues: [],
        mappings:
          currentSnapshot.observedAt === 5_100
            ? exactCodexResolverResult(currentSnapshot.observedAt).mappings
            : [],
        lifecycle: []
      }),
      dispose: () => undefined
    };
    const { app, markdownWrites } = memoryTaskApp();
    const controller = new AgentCockpitController(
      app,
      plugin,
      async (explicitBinaryPath) => {
        requestedBinaryPaths.push(explicitBinaryPath);
        const observedAt = requestedBinaryPaths.length === 1 ? 5_000 : 5_100;
        return new CmuxClient(connectedTransport(observedAt));
      },
      new ProviderMetadataService([emptyCodexMetadataSource()]),
      resolver
    );

    await controller.initialize();
    await controller.waitForBackgroundWork();
    expect(controller.store.getState().tasks).toEqual([]);

    await controller.updateSettings({
      ...controller.getSettings(),
      cmuxBinaryPath: "/alternate/cmux"
    });
    await controller.waitForBackgroundWork();

    expect(requestedBinaryPaths).toEqual(["", "/alternate/cmux"]);
    expect(controller.store.getState().snapshot?.observedAt).toBe(5_100);
    expect(markdownWrites).toHaveLength(1);
    expect(controller.store.getState().bindings).toHaveLength(1);
    expect(controller.store.getState().runs).toHaveLength(1);
    controller.dispose();
  });

  it("does not persist a binding when the automatic task disappears before attachment", async () => {
    let saveAttempts = 0;
    const plugin = {
      loadData: async () => undefined,
      saveData: async () => {
        saveAttempts += 1;
      }
    } as unknown as Plugin;
    const { app, markdownWrites } = memoryTaskApp({ removeAfterCreate: true });
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(connectedTransport(5_200)),
      new ProviderMetadataService([emptyCodexMetadataSource()]),
      exactCodexResolver()
    );

    await controller.initialize();
    await controller.waitForBackgroundWork();

    expect(markdownWrites.length).toBeGreaterThan(0);
    expect(saveAttempts).toBe(0);
    expect(controller.store.getState().tasks).toEqual([]);
    expect(controller.store.getState().bindings).toEqual([]);
    expect(controller.store.getState().runs).toEqual([]);
    controller.dispose();
  });

  it("rejects a stale manual attachment after the exact cmux surface disappears", async () => {
    let currentSnapshot = snapshot(5_300);
    const plugin = {
      loadData: async () => ({ settings: { autoTrackAgentRuns: false } }),
      saveData: async () => undefined
    } as unknown as Plugin;
    const transport: CmuxTransport = {
      ...connectedTransport(5_300),
      snapshot: async () => structuredClone(currentSnapshot)
    };
    const { app, markdownWrites } = memoryTaskApp();
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(transport)
    );

    await controller.initialize();
    await controller.waitForBackgroundWork();
    const original = controller.store.getState().sessions[0]!;
    const task = await controller.createTask({ title: "Inspect a stale attachment" });

    currentSnapshot = snapshot(5_301);
    currentSnapshot.windows[0]!.workspaces[0]!.panes[0]!.surfaces = [];
    currentSnapshot.windows[0]!.workspaces[0]!.panes[0]!.selectedSurfaceId = null;
    await controller.refreshNow();
    await controller.waitForBackgroundWork();

    await expect(controller.attachTask(original, task)).rejects.toThrow(/no longer exists/);
    await expect(
      controller.createTask({ title: "Do not create from a vanished surface" }, original)
    ).rejects.toThrow(/no longer exists/);
    expect(markdownWrites).toHaveLength(1);
    expect(controller.store.getState().bindings).toEqual([]);
    expect(controller.store.getState().runs).toEqual([]);
    controller.dispose();
  });

  it("keeps a newly created task without duplicating notices when attachment persistence fails", async () => {
    const plugin = {
      loadData: async () => ({ settings: { autoTrackAgentRuns: false } }),
      saveData: async () => {
        throw new Error("simulated binding write failure");
      }
    } as unknown as Plugin;
    const notices = (Notice as unknown as { messages: string[] }).messages;
    const noticeStart = notices.length;
    const { app, markdownWrites } = memoryTaskApp();
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(connectedTransport(5_325))
    );

    await controller.initialize();
    const session = controller.store.getState().sessions[0]!;

    await expect(
      controller.createTask({ title: "Keep partial task" }, session)
    ).resolves.toMatchObject({ title: "Keep partial task" });
    expect(markdownWrites).toHaveLength(1);
    expect(controller.store.getState().tasks).toMatchObject([{ title: "Keep partial task" }]);
    expect(controller.store.getState().bindings).toEqual([]);
    expect(controller.store.getState().runs).toEqual([]);
    expect(notices.slice(noticeStart)).toEqual([
      "Created Keep partial task, but could not attach the session: simulated binding write failure"
    ]);
    controller.dispose();
  });

  it("does not detach a newer task binding from a stale session card", async () => {
    const notices = (Notice as unknown as { messages: string[] }).messages;
    const noticeStart = notices.length;
    const plugin = {
      loadData: async () => ({ settings: { autoTrackAgentRuns: false } }),
      saveData: async () => undefined
    } as unknown as Plugin;
    const { app } = memoryTaskApp();
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(connectedTransport(5_350))
    );

    await controller.initialize();
    await controller.waitForBackgroundWork();
    const firstTask = await controller.createTask({ title: "First task" });
    const secondTask = await controller.createTask({ title: "Second task" });
    await controller.attachTask(controller.store.getState().sessions[0]!, firstTask);
    const staleSession = controller.store.getState().sessions[0]!;
    await controller.attachTask(staleSession, secondTask);

    await expect(controller.detachTask(staleSession)).rejects.toThrow(/binding changed/);
    expect(controller.store.getState().bindings).toMatchObject([
      { taskId: secondTask.taskId }
    ]);
    expect(controller.store.getState().sessions[0]?.linkedTaskId).toBe(secondTask.taskId);
    expect(notices.slice(noticeStart)).toContain(
      "The task binding changed before it could be detached. Refresh and try again."
    );
    controller.dispose();
  });

  it("does not replace a newer task binding from a stale picker", async () => {
    const plugin = {
      loadData: async () => ({ settings: { autoTrackAgentRuns: false } }),
      saveData: async () => undefined
    } as unknown as Plugin;
    const controller = new AgentCockpitController(
      memoryTaskApp().app,
      plugin,
      async () => new CmuxClient(connectedTransport(5_360))
    );

    await controller.initialize();
    await controller.waitForBackgroundWork();
    const firstTask = await controller.createTask({ title: "First task" });
    const secondTask = await controller.createTask({ title: "Second task" });
    const staleChoice = await controller.createTask({ title: "Stale task choice" });
    await controller.attachTask(controller.store.getState().sessions[0]!, firstTask);
    const staleSession = controller.store.getState().sessions[0]!;
    await controller.attachTask(staleSession, secondTask);

    await expect(controller.attachTask(staleSession, staleChoice)).rejects.toThrow(
      /binding changed while the picker was open/
    );
    expect(controller.store.getState().bindings).toMatchObject([
      { taskId: secondTask.taskId }
    ]);
    expect(controller.store.getState().sessions[0]?.linkedTaskId).toBe(secondTask.taskId);
    controller.dispose();
  });

  it("does not forget a newer conversation match from a stale session card", async () => {
    let persisted: unknown;
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const initialRepository = new BindingRepository(plugin);
    await initialRepository.load();
    await initialRepository.updateSettings({
      ...initialRepository.getSettings(),
      autoTrackAgentRuns: false
    });
    await initialRepository.mapProviderSession({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex",
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      matchedAt: "2026-09-04T00:00:00.000Z"
    });
    const controller = new AgentCockpitController(
      memoryTaskApp().app,
      plugin,
      async () => new CmuxClient(connectedTransport(5_375)),
      new ProviderMetadataService([emptyCodexMetadataSource()])
    );

    await controller.initialize();
    await controller.waitForBackgroundWork();
    const staleSession = controller.store.getState().sessions[0]!;
    const controllerBindings = (
      controller as unknown as { bindings: BindingRepository }
    ).bindings;
    await controllerBindings.mapProviderSession({
      workspaceId: staleSession.workspaceId,
      paneId: staleSession.paneId,
      surfaceId: staleSession.surfaceId,
      provider: "codex",
      providerSessionId: "66666666-6666-4666-8666-666666666666",
      matchedAt: "2026-09-04T00:01:00.000Z"
    });

    await controller.forgetConversation(staleSession);

    expect(controllerBindings.listProviderSessions()).toMatchObject([
      { providerSessionId: "66666666-6666-4666-8666-666666666666" }
    ]);
    controller.dispose();
  });

  it("does not replace a newer conversation match from a stale picker", async () => {
    let persisted: unknown;
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const initialRepository = new BindingRepository(plugin);
    await initialRepository.load();
    await initialRepository.updateSettings({
      ...initialRepository.getSettings(),
      autoTrackAgentRuns: false
    });
    await initialRepository.mapProviderSession({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex",
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      matchedAt: "2026-09-04T00:00:00.000Z"
    });
    const controller = new AgentCockpitController(
      memoryTaskApp().app,
      plugin,
      async () => new CmuxClient(connectedTransport(5_390)),
      new ProviderMetadataService([emptyCodexMetadataSource()])
    );

    await controller.initialize();
    await controller.waitForBackgroundWork();
    const staleSession = controller.store.getState().sessions[0]!;
    const controllerBindings = (
      controller as unknown as { bindings: BindingRepository }
    ).bindings;
    await controllerBindings.mapProviderSession({
      workspaceId: staleSession.workspaceId,
      paneId: staleSession.paneId,
      surfaceId: staleSession.surfaceId,
      provider: "codex",
      providerSessionId: "66666666-6666-4666-8666-666666666666",
      matchedAt: "2026-09-04T00:01:00.000Z"
    });
    const matchingController = controller as unknown as {
      matchConversation(
        original: typeof staleSession,
        conversation: ProviderSessionMetadata
      ): Promise<void>;
    };

    await expect(
      matchingController.matchConversation(staleSession, {
        provider: "codex",
        sessionId: "77777777-7777-4777-8777-777777777777",
        title: "Stale picker selection",
        titleSource: "explicit-name",
        cwd: "/repository",
        updatedAt: 5_390,
        status: "idle"
      })
    ).rejects.toThrow(/changed while the picker was open/);
    expect(controllerBindings.listProviderSessions()).toMatchObject([
      { providerSessionId: "66666666-6666-4666-8666-666666666666" }
    ]);
    controller.dispose();
  });

  it("rejects a stale manual attachment after the provider conversation changes", async () => {
    let observedAt = 5_400;
    let providerSessionId = "55555555-5555-4555-8555-55555555555a";
    const plugin = {
      loadData: async () => ({ settings: { autoTrackAgentRuns: false } }),
      saveData: async () => undefined
    } as unknown as Plugin;
    const resolver: ProviderSessionResolver = {
      resolve: async (currentSnapshot) => ({
        ...exactCodexResolverResult(currentSnapshot.observedAt),
        mappings: [
          {
            ...exactCodexResolverResult(currentSnapshot.observedAt).mappings[0]!,
            providerSessionId
          }
        ]
      }),
      dispose: () => undefined
    };
    const transport: CmuxTransport = {
      ...connectedTransport(observedAt),
      snapshot: async () => snapshot(++observedAt)
    };
    const { app, markdownWrites } = memoryTaskApp();
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(transport),
      new ProviderMetadataService([emptyCodexMetadataSource()]),
      resolver
    );

    await controller.initialize();
    await controller.waitForBackgroundWork();
    const original = controller.store.getState().sessions[0]!;
    const task = await controller.createTask({ title: "Inspect a changed conversation" });

    providerSessionId = "66666666-6666-4666-8666-66666666666b";
    await controller.refreshNow();
    await controller.waitForBackgroundWork();

    await expect(controller.attachTask(original, task)).rejects.toThrow(/conversation changed/);
    await expect(
      controller.createTask({ title: "Do not create from a replaced conversation" }, original)
    ).rejects.toThrow(/conversation changed/);
    expect(markdownWrites).toHaveLength(1);
    expect(controller.store.getState().bindings).toEqual([]);
    expect(controller.store.getState().runs).toEqual([]);
    controller.dispose();
  });

  it("loads metadata from fresh process evidence when an old saved surface is absent", async () => {
    let persisted: unknown;
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const staleMappings = new BindingRepository(plugin);
    await staleMappings.load();
    await staleMappings.updateSettings({
      ...staleMappings.getSettings(),
      autoTrackAgentRuns: false
    });
    await staleMappings.mapProviderSession({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "66666666-6666-4666-8666-666666666666",
      provider: "codex",
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      matchedAt: "2026-09-02T00:00:00.000Z"
    });
    const list = vi.fn(async () => [
      {
        provider: "codex" as const,
        sessionId: "55555555-5555-4555-8555-555555555555",
        title: "Fresh exact conversation",
        titleSource: "explicit-name" as const,
        cwd: "/repository",
        updatedAt: 5_499,
        status: "active",
        parentSessionId: null,
        sourceKind: "cli"
      }
    ]);
    const source: ProviderSessionSource = {
      provider: "codex",
      list,
      get: async () => null,
      dispose: () => undefined
    };
    const controller = new AgentCockpitController(
      memoryTaskApp().app,
      plugin,
      async () => new CmuxClient(connectedTransport(5_500)),
      new ProviderMetadataService([source]),
      exactCodexResolver()
    );

    await controller.initialize();
    await controller.waitForBackgroundWork();

    expect(list).toHaveBeenCalledWith("/repository", expect.any(AbortSignal));
    expect(controller.store.getState().sessions[0]).toMatchObject({
      provider: {
        provider: "codex",
        source: "codex-writer-lock",
        sessionId: "55555555-5555-4555-8555-555555555555"
      },
      conversation: {
        title: "Fresh exact conversation",
        matchSource: "codex-writer-lock"
      }
    });
    controller.dispose();
  });

  it("reuses the deterministic note when binding persistence recovers on a later refresh", async () => {
    let persisted: unknown;
    let saveAttempts = 0;
    let observedAt = 2_000;
    const plugin = {
      loadData: async () => persisted,
      saveData: async (next: unknown) => {
        saveAttempts += 1;
        if (saveAttempts <= 2) throw new Error("simulated plugin-data write failure");
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [],
      get: async () => null,
      dispose: () => undefined
    };
    const resolver: ProviderSessionResolver = {
      resolve: async (currentSnapshot) => ({
        checkedAt: currentSnapshot.observedAt + 1,
        nativeLifecycleAvailable: false,
        issues: [],
        mappings: [
          {
            workspaceId: "22222222-2222-4222-8222-222222222222",
            paneId: "33333333-3333-4333-8333-333333333333",
            surfaceId: "44444444-4444-4444-8444-444444444444",
            provider: "codex",
            providerSessionId: "55555555-5555-4555-8555-555555555555",
            matchSource: "codex-writer-lock",
            confidence: "high",
            explanation: "Verified exact writer identity.",
            observedAt: currentSnapshot.observedAt + 1
          }
        ],
        lifecycle: []
      }),
      dispose: () => undefined
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
      notifications: async () => [],
      readPreview: async (target) => ({ ...target, text: "", observedAt, truncated: false }),
      focusedTarget: async () => null,
      focus: async () => undefined,
      dispose: () => undefined
    };
    const { app, markdownWrites } = memoryTaskApp();
    const controller = new AgentCockpitController(
      app,
      plugin,
      async () => new CmuxClient(transport),
      new ProviderMetadataService([source]),
      resolver
    );

    await controller.initialize();
    await controller.waitForBackgroundWork();
    expect(markdownWrites).toHaveLength(1);
    expect(controller.store.getState().tasks).toHaveLength(1);
    expect(controller.store.getState().bindings).toEqual([]);
    expect(controller.store.getState().runs).toEqual([]);

    await controller.refreshNow();
    await controller.waitForBackgroundWork();
    expect(saveAttempts).toBe(3);
    expect(markdownWrites).toHaveLength(1);
    expect(controller.store.getState().tasks).toMatchObject([{ runCount: 1 }]);
    expect(controller.store.getState().bindings).toHaveLength(1);
    expect(controller.store.getState().runs).toHaveLength(1);

    await controller.refreshNow();
    await controller.waitForBackgroundWork();
    expect(saveAttempts).toBe(3);
    expect(markdownWrites).toHaveLength(1);
    controller.dispose();
  });
});
