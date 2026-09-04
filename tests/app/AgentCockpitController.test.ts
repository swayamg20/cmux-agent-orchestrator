import { TFile, TFolder, type App, type Plugin } from "obsidian";
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
import type { ProviderSessionSource } from "../../src/providers/types";

function memoryTaskApp(options: {
  failFrontmatterWrites?: number;
  beforeCreate?: () => Promise<void>;
} = {}): {
  app: App;
  markdownWrites: string[];
  createdPaths: string[];
} {
  const entries = new Map<string, TFile | TFolder>();
  const cachedFrontmatter = new Map<TFile, Record<string, unknown>>();
  const markdownWrites: string[] = [];
  const createdPaths: string[] = [];
  let frontmatterWriteAttempts = 0;
  const line = (markdown: string, key: string): string => {
    const match = markdown.match(new RegExp(`^${key}: (.+)$`, "m"));
    if (!match?.[1]) throw new Error(`Missing ${key} in task fixture.`);
    return match[1];
  };
  const jsonLine = (markdown: string, key: string): unknown => JSON.parse(line(markdown, key));
  const createFolder = async (path: string): Promise<void> => {
    const created = Object.assign(new TFolder(), { path, children: [] as Array<TFile | TFolder> });
    entries.set(path, created);
    const parent = entries.get(path.split("/").slice(0, -1).join("/"));
    if (parent instanceof TFolder) parent.children.push(created);
  };
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
      createFolder,
      create: async (path: string, markdown: string) => {
        await options.beforeCreate?.();
        createdPaths.push(path);
        markdownWrites.push(markdown);
        const name = path.split("/").pop() ?? path;
        const created = Object.assign(new TFile(), {
          path,
          extension: "md",
          basename: name.replace(/\.md$/, ""),
          stat: { ctime: Date.now(), mtime: Date.now() }
        });
        entries.set(path, created);
        const parent = entries.get(path.split("/").slice(0, -1).join("/"));
        if (parent instanceof TFolder) parent.children.push(created);
        cachedFrontmatter.set(created, {
          "agent-cockpit": "task",
          "schema-version": 1,
          "task-id": jsonLine(markdown, "task-id"),
          title: jsonLine(markdown, "title"),
          "workflow-status": line(markdown, "workflow-status"),
          priority: line(markdown, "priority"),
          repository: jsonLine(markdown, "repository"),
          branch: jsonLine(markdown, "branch"),
          worktree: jsonLine(markdown, "worktree"),
          "run-count": Number(line(markdown, "run-count")),
          "created-at": jsonLine(markdown, "created-at"),
          "updated-at": jsonLine(markdown, "updated-at")
        });
        return created;
      }
    },
    metadataCache: {
      getFileCache: (file: TFile) => ({ frontmatter: cachedFrontmatter.get(file) })
    },
    fileManager: {
      processFrontMatter: async (
        file: TFile,
        update: (frontmatter: Record<string, unknown>) => void
      ) => {
        frontmatterWriteAttempts += 1;
        if (frontmatterWriteAttempts <= (options.failFrontmatterWrites ?? 0)) {
          throw new Error("simulated task frontmatter write failure");
        }
        const frontmatter = cachedFrontmatter.get(file);
        if (!frontmatter) throw new Error("Missing task frontmatter fixture.");
        update(frontmatter);
      }
    }
  } as unknown as App;
  return { app, markdownWrites, createdPaths };
}

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
