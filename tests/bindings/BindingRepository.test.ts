import { describe, expect, it, vi } from "vitest";
import type { Plugin } from "obsidian";

import { BindingRepository } from "../../src/bindings/BindingRepository";

describe("BindingRepository", () => {
  it("imports legacy plugin data once when the renamed plugin has no data", async () => {
    let saved: unknown;
    const plugin = {
      loadData: async () => undefined,
      saveData: async (next: unknown) => {
        saved = structuredClone(next);
      }
    } as unknown as Plugin;
    const legacyData = {
      schemaVersion: 1,
      settings: { taskFolder: "Agent Cockpit/Tasks" },
      machines: {
        "00000000000000000000": {
          bindings: [
            {
              taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              workspaceId: "22222222-2222-4222-8222-222222222222",
              paneId: "33333333-3333-4333-8333-333333333333",
              surfaceId: "44444444-4444-4444-8444-444444444444",
              provider: "codex",
              providerSessionId: null,
              attachedAt: "2026-08-23T00:00:00.000Z"
            }
          ]
        }
      }
    };
    const repository = new BindingRepository(plugin, async () => legacyData);

    await repository.load();

    expect(repository.getSettings().taskFolder).toBe("Agent Cockpit/Tasks");
    expect(saved).toMatchObject({ schemaVersion: 3 });
  });

  it("prefers current plugin data without consulting the legacy loader", async () => {
    const loadLegacyData = vi.fn(async () => ({ settings: { taskFolder: "Legacy/Tasks" } }));
    const plugin = {
      loadData: async () => ({ schemaVersion: 3, settings: { taskFolder: "Current/Tasks" }, machines: {} }),
      saveData: async () => undefined
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin, loadLegacyData);

    await repository.load();

    expect(repository.getSettings().taskFolder).toBe("Current/Tasks");
    expect(loadLegacyData).not.toHaveBeenCalled();
  });

  it("persists validated machine-scoped bindings and reloads them", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const first = new BindingRepository(plugin);
    await first.load();
    await first.attach({
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex",
      providerSessionId: null,
      attachedAt: "2026-08-23T00:00:00.000Z"
    });

    const second = new BindingRepository(plugin);
    await second.load();
    expect(second.list()).toHaveLength(1);
    expect(second.list()[0]?.provider).toBe("codex");
  });

  it("drops malformed persisted identities instead of resolving short refs", async () => {
    const plugin = {
      loadData: async () => ({
        settings: {},
        machines: {
          bad: {
            bindings: [
              {
                taskId: "task:1",
                workspaceId: "workspace:1",
                paneId: "pane:1",
                surfaceId: "surface:1",
                provider: "codex",
                providerSessionId: null,
                attachedAt: "not-a-date"
              }
            ]
          }
        }
      }),
      saveData: async () => undefined
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    expect(repository.list()).toEqual([]);
  });

  it("tolerates corrupt machine entries and rejects invalid new bindings", async () => {
    const plugin = {
      loadData: async () => ({
        settings: {},
        machines: {
          "00000000000000000000": null,
          invalid: { bindings: "not-an-array" }
        }
      }),
      saveData: async () => undefined
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await expect(repository.load()).resolves.toBeUndefined();
    await expect(
      repository.attach({
        taskId: "task:1",
        workspaceId: "workspace:1",
        paneId: "pane:1",
        surfaceId: "surface:1",
        provider: "unknown",
        providerSessionId: null,
        attachedAt: "not-a-date"
      })
    ).rejects.toThrow(/invalid canonical identity/);
    expect(repository.list()).toEqual([]);
  });

  it("does not retain a binding when persistence fails and recovers the save queue", async () => {
    let shouldFail = true;
    const plugin = {
      loadData: async () => undefined,
      saveData: async () => {
        if (shouldFail) throw new Error("disk unavailable");
      }
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const binding = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex" as const,
      providerSessionId: null,
      attachedAt: "2026-08-23T00:00:00.000Z"
    };
    await expect(repository.attach(binding)).rejects.toThrow(/disk unavailable/);
    expect(repository.list()).toEqual([]);

    shouldFail = false;
    await expect(repository.attach(binding)).resolves.toMatchObject({ isNewRun: true });
    expect(repository.list()).toHaveLength(1);
  });

  it("migrates schema-v1 bindings to stable identities without losing the mapping", async () => {
    let data: unknown = {
      schemaVersion: 1,
      settings: {},
      machines: {
        "00000000000000000000": {
          bindings: [
            {
              taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              workspaceId: "22222222-2222-4222-8222-222222222222",
              paneId: "33333333-3333-4333-8333-333333333333",
              surfaceId: "44444444-4444-4444-8444-444444444444",
              provider: "codex",
              providerSessionId: null,
              attachedAt: "2026-08-23T00:00:00.000Z"
            }
          ]
        }
      }
    };
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    await repository.updateSettings(repository.getSettings());

    const saved = data as {
      schemaVersion: number;
      machines: Record<string, {
        bindings: { bindingId: string; runId: string }[];
        runs: { runId: string }[];
        providerSessions: unknown[];
      }>;
    };
    expect(saved.schemaVersion).toBe(3);
    const savedBinding = saved.machines["00000000000000000000"]?.bindings[0];
    expect(savedBinding?.bindingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(savedBinding?.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.machines["00000000000000000000"]?.runs).toHaveLength(1);
    expect(saved.machines["00000000000000000000"]?.providerSessions).toEqual([]);
  });

  it("persists one exact provider conversation match per cmux surface", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const mapping = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex" as const,
      providerSessionId: "55555555-5555-4555-8555-55555555555A",
      matchedAt: "2026-09-02T00:00:00.000Z"
    };
    const first = new BindingRepository(plugin);
    await first.load();
    await first.mapProviderSession(mapping);

    const second = new BindingRepository(plugin);
    await second.load();
    expect(second.listProviderSessions()).toEqual([
      {
        ...mapping,
        providerSessionId: mapping.providerSessionId.toLowerCase()
      }
    ]);
  });

  it("rejects assigning one provider conversation to two surfaces", async () => {
    const plugin = {
      loadData: async () => undefined,
      saveData: async () => undefined
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const mapping = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "claude" as const,
      providerSessionId: "55555555-5555-4555-8555-55555555555a",
      matchedAt: "2026-09-02T00:00:00.000Z"
    };
    await repository.mapProviderSession(mapping);
    await expect(
      repository.mapProviderSession({
        ...mapping,
        surfaceId: "66666666-6666-4666-8666-666666666666",
        providerSessionId: mapping.providerSessionId.toUpperCase()
      })
    ).rejects.toThrow(/already matched/);
    expect(repository.listProviderSessions()).toEqual([mapping]);
  });

  it("drops every ambiguous persisted provider conversation claim", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const mapping = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex" as const,
      providerSessionId: "55555555-5555-4555-8555-55555555555a",
      matchedAt: "2026-09-02T00:00:00.000Z"
    };
    const first = new BindingRepository(plugin);
    await first.load();
    await first.mapProviderSession(mapping);

    const machine = Object.values(
      (data as { machines: Record<string, { providerSessions: unknown[] }> }).machines
    )[0]!;
    machine.providerSessions.push({
      ...mapping,
      surfaceId: "66666666-6666-4666-8666-666666666666",
      providerSessionId: mapping.providerSessionId.toUpperCase()
    });

    const second = new BindingRepository(plugin);
    await second.load();

    expect(second.listProviderSessions()).toEqual([]);
  });

  it("drops every persisted identity when one surface has conflicting conversations", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const mapping = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "claude" as const,
      providerSessionId: "55555555-5555-4555-8555-55555555555a",
      matchedAt: "2026-09-02T00:00:00.000Z"
    };
    const first = new BindingRepository(plugin);
    await first.load();
    await first.mapProviderSession(mapping);

    const machine = Object.values(
      (data as { machines: Record<string, { providerSessions: unknown[] }> }).machines
    )[0]!;
    machine.providerSessions.push({
      ...mapping,
      provider: "codex",
      providerSessionId: "66666666-6666-4666-8666-666666666666"
    });

    const second = new BindingRepository(plugin);
    await second.load();

    expect(second.listProviderSessions()).toEqual([]);
  });

  it("rejects a provider conversation already claimed by another task binding", async () => {
    const plugin = {
      loadData: async () => undefined,
      saveData: async () => undefined
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const providerSessionId = "55555555-5555-4555-8555-555555555555";
    await repository.attach({
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex",
      providerSessionId,
      attachedAt: "2026-09-02T00:00:00.000Z"
    });

    await expect(
      repository.mapProviderSession({
        workspaceId: "22222222-2222-4222-8222-222222222222",
        paneId: "33333333-3333-4333-8333-333333333333",
        surfaceId: "66666666-6666-4666-8666-666666666666",
        provider: "codex",
        providerSessionId,
        matchedAt: "2026-09-02T00:01:00.000Z"
      })
    ).rejects.toThrow(/already matched/);
    expect(repository.listProviderSessions()).toEqual([]);
  });

  it("rejects attaching a provider conversation already claimed by another surface", async () => {
    const plugin = {
      loadData: async () => undefined,
      saveData: async () => undefined
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const providerSessionId = "55555555-5555-4555-8555-55555555555a";
    const first = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex" as const,
      providerSessionId,
      attachedAt: "2026-09-02T00:00:00.000Z"
    };
    await repository.attach(first);

    await expect(
      repository.attach({
        ...first,
        taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        surfaceId: "66666666-6666-4666-8666-666666666666",
        providerSessionId: providerSessionId.toUpperCase()
      })
    ).rejects.toThrow(/already matched/);
    expect(repository.list()).toMatchObject([{ surfaceId: first.surfaceId }]);
    expect(repository.listRuns()).toHaveLength(1);
  });

  it("rejects attachment when a saved conversation mapping claims another surface", async () => {
    const plugin = {
      loadData: async () => undefined,
      saveData: async () => undefined
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const providerSessionId = "55555555-5555-4555-8555-55555555555a";
    await repository.mapProviderSession({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "claude",
      providerSessionId,
      matchedAt: "2026-09-02T00:00:00.000Z"
    });

    await expect(
      repository.attach({
        taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        paneId: "33333333-3333-4333-8333-333333333333",
        surfaceId: "66666666-6666-4666-8666-666666666666",
        provider: "claude",
        providerSessionId: providerSessionId.toUpperCase(),
        attachedAt: "2026-09-02T00:01:00.000Z"
      })
    ).rejects.toThrow(/already matched/);
    expect(repository.list()).toEqual([]);
    expect(repository.listRuns()).toEqual([]);
  });

  it("updates and clears the attached run identity with the provider match", async () => {
    const plugin = {
      loadData: async () => undefined,
      saveData: async () => undefined
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const surfaceId = "44444444-4444-4444-8444-444444444444";
    await repository.attach({
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId,
      provider: "codex",
      providerSessionId: null,
      attachedAt: "2026-09-02T00:00:00.000Z"
    });
    await repository.mapProviderSession({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId,
      provider: "codex",
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      matchedAt: "2026-09-02T00:01:00.000Z"
    });
    expect(repository.findBySurface(surfaceId)?.providerSessionId).toBe(
      "55555555-5555-4555-8555-555555555555"
    );
    expect(repository.listRuns()[0]?.providerSessionId).toBe(
      "55555555-5555-4555-8555-555555555555"
    );
    expect(repository.listRuns()[0]?.lastAttachedAt).toBe("2026-09-02T00:00:00.000Z");

    await repository.forgetProviderSession(surfaceId);
    expect(repository.findBySurface(surfaceId)?.providerSessionId).toBeNull();
    expect(repository.listRuns()[0]?.providerSessionId).toBeNull();
  });

  it("keeps several runs for one durable task and reuses the run on repeated attachment", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const base = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      provider: "codex" as const,
      providerSessionId: null,
      attachedAt: "2026-08-23T00:00:00.000Z"
    };
    const first = await repository.attach({
      ...base,
      surfaceId: "44444444-4444-4444-8444-444444444444"
    });
    const second = await repository.attach({
      ...base,
      surfaceId: "55555555-5555-4555-8555-555555555555",
      attachedAt: "2026-08-23T00:01:00.000Z"
    });
    const repeated = await repository.attach({
      ...base,
      surfaceId: "55555555-5555-4555-8555-555555555555",
      attachedAt: "2026-08-23T00:02:00.000Z"
    });

    expect(first.isNewRun).toBe(true);
    expect(second.isNewRun).toBe(true);
    expect(repeated).toMatchObject({ isNewRun: false, run: { runId: second.run.runId } });
    expect(repository.listRuns(base.taskId)).toHaveLength(2);
    expect(repository.list()).toHaveLength(2);
  });
});
