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

  it("accepts a legacy import save failure only when exact read-back proves persistence", async () => {
    let persisted: unknown;
    const plugin = {
      loadData: async () => structuredClone(persisted),
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
        throw new Error("migration acknowledgement lost");
      }
    } as unknown as Plugin;
    const legacyData = {
      schemaVersion: 1,
      settings: { taskFolder: "Agent Cockpit/Tasks" },
      machines: {}
    };
    const repository = new BindingRepository(plugin, async () => legacyData);

    await expect(repository.load()).resolves.toBeUndefined();

    expect(repository.getSettings().taskFolder).toBe("Agent Cockpit/Tasks");
    expect(persisted).toMatchObject({ schemaVersion: 3 });
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

  it("bounds decoding work for malformed persisted record arrays", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const seed = new BindingRepository(plugin);
    await seed.load();
    await seed.attach({
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex",
      providerSessionId: null,
      attachedAt: "2026-09-04T00:00:00.000Z"
    });
    const machine = Object.values(
      (data as {
        machines: Record<string, {
          bindings: unknown[];
          runs: unknown[];
          providerSessions: unknown[];
        }>;
      }).machines
    )[0]!;
    const guardedCandidates = (limit: number, label: string): unknown[] => {
      const values = new Array<unknown>(limit + 1);
      Object.defineProperty(values, limit, {
        get: () => {
          throw new Error(`${label} decoder exceeded its candidate limit`);
        }
      });
      return values;
    };
    machine.bindings = guardedCandidates(5_000, "binding");
    machine.runs = guardedCandidates(20_000, "run");
    machine.providerSessions = guardedCandidates(5_000, "provider session");

    const repository = new BindingRepository(plugin);
    await expect(repository.load()).resolves.toBeUndefined();
    expect(repository.list()).toEqual([]);
    expect(repository.listRuns()).toEqual([]);
    expect(repository.listProviderSessions()).toEqual([]);
  });

  it("retains the current machine when synced data contains the maximum other namespaces", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const seed = new BindingRepository(plugin);
    await seed.load();
    await seed.attach({
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex",
      providerSessionId: null,
      attachedAt: "2026-09-04T00:00:00.000Z"
    });
    const stored = data as {
      schemaVersion: number;
      settings: unknown;
      machines: Record<string, unknown>;
    };
    const currentMachineId = Object.keys(stored.machines)[0]!;
    const currentMachine = stored.machines[currentMachineId];
    const crowdedMachines: Record<string, unknown> = {};
    for (let index = 0; index < 100; index += 1) {
      const id = index.toString(16).padStart(20, "0");
      if (id !== currentMachineId) {
        crowdedMachines[id] = { bindings: [], runs: [], providerSessions: [] };
      }
    }
    crowdedMachines[currentMachineId] = currentMachine;
    data = { ...stored, machines: crowdedMachines };

    const reloaded = new BindingRepository(plugin);
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(1);

    await reloaded.updateSettings(reloaded.getSettings());
    const persistedMachines = (data as { machines: Record<string, unknown> }).machines;
    expect(Object.keys(persistedMachines)).toHaveLength(100);
    expect(persistedMachines[currentMachineId]).toBeDefined();
  });

  it("drops every conflicting persisted task binding claim", async () => {
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
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      provider: "codex" as const,
      providerSessionId: null,
      attachedAt: "2026-09-04T00:00:00.000Z"
    };
    const firstSurface = "44444444-4444-4444-8444-444444444444";
    await repository.attach({
      ...base,
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      surfaceId: firstSurface
    });
    await repository.attach({
      ...base,
      taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      surfaceId: "55555555-5555-4555-8555-555555555555"
    });
    const machine = Object.values(
      (data as {
        machines: Record<string, { bindings: Array<{ surfaceId: string }> }>;
      }).machines
    )[0]!;
    machine.bindings[1]!.surfaceId = firstSurface;

    const reloaded = new BindingRepository(plugin);
    await reloaded.load();

    expect(reloaded.list()).toEqual([]);
    expect(reloaded.listRuns()).toHaveLength(2);
  });

  it("drops conflicting run identities and every binding that depends on them", async () => {
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
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      provider: "codex" as const,
      providerSessionId: null,
      attachedAt: "2026-09-04T00:00:00.000Z"
    };
    await repository.attach({
      ...base,
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      surfaceId: "44444444-4444-4444-8444-444444444444"
    });
    await repository.attach({
      ...base,
      taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      surfaceId: "55555555-5555-4555-8555-555555555555"
    });
    const machine = Object.values(
      (data as {
        machines: Record<string, { runs: Array<{ runId: string }> }>;
      }).machines
    )[0]!;
    machine.runs[1]!.runId = machine.runs[0]!.runId;

    const reloaded = new BindingRepository(plugin);
    await reloaded.load();

    expect(reloaded.listRuns()).toEqual([]);
    expect(reloaded.list()).toEqual([]);
  });

  it("drops a provider conversation claimed by a binding and a different surface mapping", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const target = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex" as const,
      providerSessionId: "55555555-5555-4555-8555-555555555555"
    };
    await repository.attach({
      ...target,
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      attachedAt: "2026-09-04T00:00:00.000Z"
    });
    await repository.mapProviderSession({
      ...target,
      matchedAt: "2026-09-04T00:01:00.000Z"
    });
    const machine = Object.values(
      (data as {
        machines: Record<string, {
          providerSessions: Array<{ surfaceId: string }>;
        }>;
      }).machines
    )[0]!;
    machine.providerSessions[0]!.surfaceId = "66666666-6666-4666-8666-666666666666";

    const reloaded = new BindingRepository(plugin);
    await reloaded.load();

    expect(reloaded.list()).toEqual([]);
    expect(reloaded.listProviderSessions()).toEqual([]);
    expect(reloaded.listRuns()).toHaveLength(1);
  });

  it("drops conflicting exact conversations claimed for the same persisted surface", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const target = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "claude" as const,
      providerSessionId: "55555555-5555-4555-8555-555555555555"
    };
    await repository.attach({
      ...target,
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      attachedAt: "2026-09-04T00:00:00.000Z"
    });
    await repository.mapProviderSession({
      ...target,
      matchedAt: "2026-09-04T00:01:00.000Z"
    });
    const machine = Object.values(
      (data as {
        machines: Record<string, {
          providerSessions: Array<{ providerSessionId: string }>;
        }>;
      }).machines
    )[0]!;
    machine.providerSessions[0]!.providerSessionId =
      "66666666-6666-4666-8666-666666666666";

    const reloaded = new BindingRepository(plugin);
    await reloaded.load();

    expect(reloaded.list()).toEqual([]);
    expect(reloaded.listProviderSessions()).toEqual([]);
    expect(reloaded.listRuns()).toHaveLength(1);
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

  it("keeps the conditional save queue usable after a handled persistence failure", async () => {
    let shouldFail = true;
    const plugin = {
      loadData: async () => undefined,
      saveData: async () => {
        if (shouldFail) throw new Error("conditional disk unavailable");
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

    await expect(repository.attachIfSurfaceUnchanged(binding, null)).rejects.toThrow(
      /conditional disk unavailable/
    );
    expect(repository.list()).toEqual([]);

    shouldFail = false;
    await expect(repository.attachIfSurfaceUnchanged(binding, null)).resolves.toMatchObject({
      isNewRun: true
    });
    expect(repository.list()).toHaveLength(1);
  });

  it("accepts a reported save failure only when read-back proves the exact binding persisted", async () => {
    let persisted: unknown;
    let rejectAfterWrite = true;
    const plugin = {
      loadData: async () => structuredClone(persisted),
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
        if (rejectAfterWrite) {
          rejectAfterWrite = false;
          throw new Error("write acknowledgement lost");
        }
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
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      attachedAt: "2026-09-04T00:00:00.000Z"
    };

    const first = await repository.attachIfSurfaceUnchanged(binding, null);
    const repeated = await repository.attachIfSurfaceUnchanged(binding, first?.binding ?? null);

    expect(first).toMatchObject({ isNewRun: true });
    expect(repeated).toMatchObject({ isNewRun: false, run: { runId: first?.run.runId } });
    expect(repository.list()).toHaveLength(1);
    expect(repository.listRuns()).toHaveLength(1);
  });

  it("does not let a conditional automatic attachment replace a queued explicit binding", async () => {
    let data: unknown;
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
      loadData: async () => data,
      saveData: async (next: unknown) => {
        saveCount += 1;
        if (saveCount === 1) {
          markFirstSaveStarted?.();
          await firstSaveGate;
        }
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const target = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex" as const,
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      attachedAt: "2026-09-04T00:00:00.000Z"
    };

    const explicit = repository.attach({
      ...target,
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    });
    await firstSaveStarted;
    const automatic = repository.attachIfSurfaceUnchanged(
      {
        ...target,
        taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        attachedAt: "2026-09-04T00:00:01.000Z"
      },
      null
    );
    releaseFirstSave?.();

    await expect(explicit).resolves.toMatchObject({ isNewRun: true });
    await expect(automatic).resolves.toBeNull();
    expect(saveCount).toBe(1);
    expect(repository.list()).toMatchObject([
      { taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }
    ]);
    expect(repository.listRuns()).toHaveLength(1);
  });

  it("cancels a queued conditional attachment when its authority expires", async () => {
    let data: unknown;
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
      loadData: async () => data,
      saveData: async (next: unknown) => {
        saveCount += 1;
        if (saveCount === 1) {
          markFirstSaveStarted?.();
          await firstSaveGate;
        }
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();

    const settingsSave = repository.updateSettings({
      ...repository.getSettings(),
      staleAfterMs: 60 * 60_000
    });
    await firstSaveStarted;
    let allowed = true;
    const automatic = repository.attachIfSurfaceUnchanged(
      {
        taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        paneId: "33333333-3333-4333-8333-333333333333",
        surfaceId: "44444444-4444-4444-8444-444444444444",
        provider: "codex",
        providerSessionId: "55555555-5555-4555-8555-555555555555",
        attachedAt: "2026-09-04T00:00:00.000Z"
      },
      null,
      () => allowed
    );
    allowed = false;
    releaseFirstSave?.();

    await settingsSave;
    await expect(automatic).resolves.toBeNull();
    expect(saveCount).toBe(1);
    expect(repository.list()).toEqual([]);
    expect(repository.listRuns()).toEqual([]);
  });

  it("does not let a stale conditional detach remove a queued replacement binding", async () => {
    let data: unknown;
    let releaseReplacementSave: (() => void) | undefined;
    let markReplacementSaveStarted: (() => void) | undefined;
    const replacementSaveStarted = new Promise<void>((resolve) => {
      markReplacementSaveStarted = resolve;
    });
    const replacementSaveGate = new Promise<void>((resolve) => {
      releaseReplacementSave = resolve;
    });
    let saveCount = 0;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        saveCount += 1;
        if (saveCount === 2) {
          markReplacementSaveStarted?.();
          await replacementSaveGate;
        }
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const target = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex" as const,
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      attachedAt: "2026-09-04T00:00:00.000Z"
    };
    const original = await repository.attach({
      ...target,
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    });
    const replacement = repository.attach({
      ...target,
      taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      attachedAt: "2026-09-04T00:00:01.000Z"
    });
    await replacementSaveStarted;
    const staleDetach = repository.detachIfUnchanged(original.binding);
    releaseReplacementSave?.();

    await expect(replacement).resolves.toMatchObject({ isNewRun: true });
    await expect(staleDetach).resolves.toBe(false);
    expect(saveCount).toBe(2);
    expect(repository.list()).toMatchObject([
      { taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }
    ]);
    expect(repository.listRuns()).toHaveLength(2);
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

  it("atomically relocates an exact provider session without creating another run", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const original = await repository.attach({
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex",
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      attachedAt: "2026-09-02T00:00:00.000Z"
    });
    await repository.mapProviderSession({
      workspaceId: original.binding.workspaceId,
      paneId: original.binding.paneId,
      surfaceId: original.binding.surfaceId,
      provider: "codex",
      providerSessionId: original.binding.providerSessionId!,
      matchedAt: "2026-09-02T00:01:00.000Z"
    });

    const relocated = await repository.relocateProviderSession({
      bindingId: original.binding.bindingId.toUpperCase(),
      runId: original.run.runId.toUpperCase(),
      taskId: original.binding.taskId.toUpperCase(),
      provider: "codex",
      providerSessionId: original.binding.providerSessionId!.toUpperCase(),
      fromWorkspaceId: original.binding.workspaceId.toUpperCase(),
      fromPaneId: original.binding.paneId.toUpperCase(),
      fromSurfaceId: original.binding.surfaceId.toUpperCase(),
      toWorkspaceId: "66666666-6666-4666-8666-666666666666",
      toPaneId: "77777777-7777-4777-8777-777777777777",
      toSurfaceId: "88888888-8888-4888-8888-888888888888",
      relocatedAt: "2026-09-02T00:02:00.000Z"
    });

    expect(relocated).toMatchObject({
      bindingId: original.binding.bindingId,
      runId: original.run.runId,
      taskId: original.binding.taskId,
      workspaceId: "66666666-6666-4666-8666-666666666666",
      paneId: "77777777-7777-4777-8777-777777777777",
      surfaceId: "88888888-8888-4888-8888-888888888888",
      attachedAt: "2026-09-02T00:02:00.000Z"
    });
    expect(repository.list()).toEqual([relocated]);
    expect(repository.listRuns()).toMatchObject([
      {
        runId: original.run.runId,
        firstAttachedAt: "2026-09-02T00:00:00.000Z",
        lastAttachedAt: "2026-09-02T00:02:00.000Z"
      }
    ]);
    expect(repository.listProviderSessions()).toMatchObject([
      {
        workspaceId: relocated.workspaceId,
        paneId: relocated.paneId,
        surfaceId: relocated.surfaceId,
        matchedAt: "2026-09-02T00:02:00.000Z"
      }
    ]);
  });

  it("cancels a queued relocation when its authority expires", async () => {
    let data: unknown;
    let blockNextSave = false;
    let releaseBlockedSave: (() => void) | undefined;
    let markBlockedSaveStarted: (() => void) | undefined;
    const blockedSaveStarted = new Promise<void>((resolve) => {
      markBlockedSaveStarted = resolve;
    });
    const blockedSaveGate = new Promise<void>((resolve) => {
      releaseBlockedSave = resolve;
    });
    let saveCount = 0;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        saveCount += 1;
        if (blockNextSave) {
          blockNextSave = false;
          markBlockedSaveStarted?.();
          await blockedSaveGate;
        }
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const original = await repository.attach({
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex",
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      attachedAt: "2026-09-04T00:00:00.000Z"
    });

    blockNextSave = true;
    const settingsSave = repository.updateSettings({
      ...repository.getSettings(),
      staleAfterMs: 60 * 60_000
    });
    await blockedSaveStarted;
    let allowed = true;
    const relocation = repository.relocateProviderSession(
      {
        bindingId: original.binding.bindingId,
        runId: original.run.runId,
        taskId: original.binding.taskId,
        provider: "codex",
        providerSessionId: original.binding.providerSessionId!,
        fromWorkspaceId: original.binding.workspaceId,
        fromPaneId: original.binding.paneId,
        fromSurfaceId: original.binding.surfaceId,
        toWorkspaceId: "66666666-6666-4666-8666-666666666666",
        toPaneId: "77777777-7777-4777-8777-777777777777",
        toSurfaceId: "88888888-8888-4888-8888-888888888888",
        relocatedAt: "2026-09-04T00:01:00.000Z"
      },
      () => allowed
    );
    allowed = false;
    releaseBlockedSave?.();

    await settingsSave;
    await expect(relocation).resolves.toBeNull();
    expect(saveCount).toBe(2);
    expect(repository.list()).toEqual([original.binding]);
    expect(repository.listRuns()).toEqual([original.run]);
  });

  it("rejects relocation when the expected source binding has changed", async () => {
    const plugin = {
      loadData: async () => undefined,
      saveData: async () => undefined
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const original = await repository.attach({
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "claude",
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      attachedAt: "2026-09-02T00:00:00.000Z"
    });

    await expect(
      repository.relocateProviderSession({
        bindingId: original.binding.bindingId,
        runId: original.run.runId,
        taskId: original.binding.taskId,
        provider: "claude",
        providerSessionId: original.binding.providerSessionId!,
        fromWorkspaceId: original.binding.workspaceId,
        fromPaneId: original.binding.paneId,
        fromSurfaceId: "99999999-9999-4999-8999-999999999999",
        toWorkspaceId: "66666666-6666-4666-8666-666666666666",
        toPaneId: "77777777-7777-4777-8777-777777777777",
        toSurfaceId: "88888888-8888-4888-8888-888888888888",
        relocatedAt: "2026-09-02T00:02:00.000Z"
      })
    ).rejects.toThrow(/changed before it could be relocated/);
    expect(repository.list()).toEqual([original.binding]);
    expect(repository.listRuns()).toEqual([original.run]);
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

  it("drops a cross-task binding before mapping and leaves the unrelated run unchanged", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const taskA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const taskB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const target = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444"
    };
    const seed = new BindingRepository(plugin);
    await seed.load();
    const original = await seed.attach({
      ...target,
      taskId: taskB,
      provider: "codex",
      providerSessionId: null,
      attachedAt: "2026-09-04T00:00:00.000Z"
    });
    const machine = Object.values(
      (data as {
        machines: Record<string, {
          bindings: Array<{ taskId: string }>;
        }>;
      }).machines
    )[0]!;
    machine.bindings[0]!.taskId = taskA;

    const repository = new BindingRepository(plugin);
    await repository.load();
    const mapping = {
      ...target,
      provider: "codex" as const,
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      matchedAt: "2026-09-04T00:01:00.000Z"
    };
    await expect(repository.mapProviderSession(mapping)).resolves.toBeUndefined();

    expect(repository.listProviderSessions()).toEqual([mapping]);
    expect(repository.findBySurface(target.surfaceId)).toBeNull();
    expect(repository.listRuns(taskB)).toEqual([original.run]);
  });

  it("forgets a mapping after its malformed binding was dropped without clearing another task's run", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const taskA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const taskB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const providerSessionId = "55555555-5555-4555-8555-555555555555";
    const target = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444"
    };
    const seed = new BindingRepository(plugin);
    await seed.load();
    const original = await seed.attach({
      ...target,
      taskId: taskB,
      provider: "codex",
      providerSessionId,
      attachedAt: "2026-09-04T00:00:00.000Z"
    });
    await seed.mapProviderSession({
      ...target,
      provider: "codex",
      providerSessionId,
      matchedAt: "2026-09-04T00:01:00.000Z"
    });
    const machine = Object.values(
      (data as {
        machines: Record<string, {
          bindings: Array<{ taskId: string }>;
        }>;
      }).machines
    )[0]!;
    machine.bindings[0]!.taskId = taskA;

    const repository = new BindingRepository(plugin);
    await repository.load();
    await repository.forgetProviderSession(target.surfaceId);

    expect(repository.listProviderSessions()).toEqual([]);
    expect(repository.findBySurface(target.surfaceId)).toBeNull();
    expect(repository.listRuns(taskB)).toEqual([
      { ...original.run, providerSessionId }
    ]);
  });

  it("does not let a stale conditional forget remove a queued replacement conversation", async () => {
    let data: unknown;
    let releaseReplacementSave: (() => void) | undefined;
    let markReplacementSaveStarted: (() => void) | undefined;
    const replacementSaveStarted = new Promise<void>((resolve) => {
      markReplacementSaveStarted = resolve;
    });
    const replacementSaveGate = new Promise<void>((resolve) => {
      releaseReplacementSave = resolve;
    });
    let saveCount = 0;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        saveCount += 1;
        if (saveCount === 3) {
          markReplacementSaveStarted?.();
          await replacementSaveGate;
        }
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const target = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex" as const
    };
    const original = {
      ...target,
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      matchedAt: "2026-09-04T00:00:00.000Z"
    };
    const replacement = {
      ...target,
      providerSessionId: "66666666-6666-4666-8666-666666666666",
      matchedAt: "2026-09-04T00:01:00.000Z"
    };
    await repository.attach({
      ...target,
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      providerSessionId: null,
      attachedAt: "2026-09-04T00:00:00.000Z"
    });
    await repository.mapProviderSession(original);

    const replacementWrite = repository.mapProviderSession(replacement);
    await replacementSaveStarted;
    const staleForget = repository.forgetProviderSessionIfUnchanged(original);
    releaseReplacementSave?.();

    await expect(replacementWrite).resolves.toBeUndefined();
    await expect(staleForget).resolves.toBe(false);
    expect(saveCount).toBe(3);
    expect(repository.listProviderSessions()).toEqual([replacement]);
    expect(repository.findBySurface(target.surfaceId)?.providerSessionId).toBe(
      replacement.providerSessionId
    );
    expect(repository.listRuns()[0]?.providerSessionId).toBe(replacement.providerSessionId);
  });

  it("does not let a stale conditional conversation choice replace a queued mapping", async () => {
    let data: unknown;
    let releaseReplacementSave: (() => void) | undefined;
    let markReplacementSaveStarted: (() => void) | undefined;
    const replacementSaveStarted = new Promise<void>((resolve) => {
      markReplacementSaveStarted = resolve;
    });
    const replacementSaveGate = new Promise<void>((resolve) => {
      releaseReplacementSave = resolve;
    });
    let saveCount = 0;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        saveCount += 1;
        if (saveCount === 2) {
          markReplacementSaveStarted?.();
          await replacementSaveGate;
        }
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const target = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex" as const
    };
    const original = {
      ...target,
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      matchedAt: "2026-09-04T00:00:00.000Z"
    };
    const replacement = {
      ...target,
      providerSessionId: "66666666-6666-4666-8666-666666666666",
      matchedAt: "2026-09-04T00:01:00.000Z"
    };
    const staleChoice = {
      ...target,
      providerSessionId: "77777777-7777-4777-8777-777777777777",
      matchedAt: "2026-09-04T00:02:00.000Z"
    };
    await expect(repository.mapProviderSessionIfUnchanged(original, null)).resolves.toBe(true);

    const replacementWrite = repository.mapProviderSession(replacement);
    await replacementSaveStarted;
    const staleWrite = repository.mapProviderSessionIfUnchanged(staleChoice, original);
    releaseReplacementSave?.();

    await expect(replacementWrite).resolves.toBeUndefined();
    await expect(staleWrite).resolves.toBe(false);
    expect(saveCount).toBe(2);
    expect(repository.listProviderSessions()).toEqual([replacement]);
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

  it("reuses one exact provider run after its surface is detached and reattached", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const repository = new BindingRepository(plugin);
    await repository.load();
    const input = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex" as const,
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      attachedAt: "2026-09-04T00:00:00.000Z"
    };

    const first = await repository.attach(input);
    await repository.detach(input.surfaceId);
    const reattached = await repository.attach({
      ...input,
      attachedAt: "2026-09-04T00:01:00.000Z"
    });

    expect(reattached).toMatchObject({
      isNewRun: false,
      run: {
        runId: first.run.runId,
        firstAttachedAt: input.attachedAt,
        lastAttachedAt: "2026-09-04T00:01:00.000Z"
      }
    });
    expect(repository.listRuns(input.taskId)).toHaveLength(1);
    expect(repository.list()).toHaveLength(1);
  });

  it("refuses to choose between duplicate historical runs for one exact provider session", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => structuredClone(data),
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const input = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex" as const,
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      attachedAt: "2026-09-04T00:00:00.000Z"
    };
    const seed = new BindingRepository(plugin);
    await seed.load();
    const first = await seed.attach(input);
    await seed.detach(input.surfaceId);
    const machine = Object.values(
      (data as { machines: Record<string, { runs: Array<Record<string, unknown>> }> }).machines
    )[0]!;
    machine.runs.push({
      ...first.run,
      runId: "66666666-6666-4666-8666-666666666666",
      relation: "resume",
      parentRunId: first.run.runId,
      firstAttachedAt: "2026-09-04T00:01:00.000Z",
      lastAttachedAt: "2026-09-04T00:01:00.000Z"
    });
    const repository = new BindingRepository(plugin);
    await repository.load();

    await expect(
      repository.attach({ ...input, attachedAt: "2026-09-04T00:02:00.000Z" })
    ).rejects.toThrow("ambiguous run history");
    expect(repository.listRuns(input.taskId)).toHaveLength(2);
    expect(repository.list()).toEqual([]);
  });

  it("does not reuse a persisted run that belongs to another task", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const taskA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const taskB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const input = {
      taskId: taskB,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex" as const,
      providerSessionId: "55555555-5555-4555-8555-555555555555",
      attachedAt: "2026-09-04T00:00:00.000Z"
    };
    const first = new BindingRepository(plugin);
    await first.load();
    const original = await first.attach(input);

    const machine = Object.values(
      (data as {
        machines: Record<string, {
          bindings: Array<{ taskId: string }>;
        }>;
      }).machines
    )[0]!;
    machine.bindings[0]!.taskId = taskA;

    const second = new BindingRepository(plugin);
    await second.load();
    const repaired = await second.attach({
      ...input,
      taskId: taskA,
      attachedAt: "2026-09-04T00:01:00.000Z"
    });

    expect(repaired.isNewRun).toBe(true);
    expect(repaired.run).toMatchObject({ taskId: taskA });
    expect(repaired.run.runId).not.toBe(original.run.runId);
    expect(repaired.binding.runId).toBe(repaired.run.runId);
    expect(second.listRuns(taskA)).toHaveLength(1);
    expect(second.listRuns(taskB)).toEqual([original.run]);
  });

  it("normalizes persisted identities and accepts canonical lookups with different casing", async () => {
    let data: unknown;
    const plugin = {
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = structuredClone(next);
      }
    } as unknown as Plugin;
    const taskId = "a1111111-a111-4111-8111-a11111111111";
    const workspaceId = "b2222222-b222-4222-8222-b22222222222";
    const paneId = "c3333333-c333-4333-8333-c33333333333";
    const surfaceId = "d4444444-d444-4444-8444-d44444444444";
    const providerSessionId = "e5555555-e555-4555-8555-e55555555555";
    const first = new BindingRepository(plugin);
    await first.load();
    await first.attach({
      taskId,
      workspaceId,
      paneId,
      surfaceId,
      provider: "codex",
      providerSessionId,
      attachedAt: "2026-09-04T00:00:00.000Z"
    });
    await first.mapProviderSession({
      workspaceId,
      paneId,
      surfaceId,
      provider: "codex",
      providerSessionId,
      matchedAt: "2026-09-04T00:01:00.000Z"
    });

    const machine = Object.values(
      (data as {
        machines: Record<string, {
          bindings: Array<Record<string, string | null>>;
          runs: Array<Record<string, string | null>>;
          providerSessions: Array<Record<string, string>>;
        }>;
      }).machines
    )[0]!;
    for (const bindingRecord of machine.bindings) {
      for (const key of ["bindingId", "runId", "taskId", "workspaceId", "paneId", "surfaceId", "providerSessionId"]) {
        const value = bindingRecord[key];
        if (typeof value === "string") bindingRecord[key] = value.toUpperCase();
      }
    }
    for (const run of machine.runs) {
      for (const key of ["runId", "taskId", "parentRunId", "providerSessionId"]) {
        const value = run[key];
        if (typeof value === "string") run[key] = value.toUpperCase();
      }
    }
    for (const mapping of machine.providerSessions) {
      for (const key of ["workspaceId", "paneId", "surfaceId", "providerSessionId"]) {
        mapping[key] = mapping[key]!.toUpperCase();
      }
    }

    const second = new BindingRepository(plugin);
    await second.load();

    expect(second.list()[0]).toMatchObject({ taskId, workspaceId, paneId, surfaceId, providerSessionId });
    expect(second.listRuns()[0]).toMatchObject({ taskId, providerSessionId });
    expect(second.listProviderSessions()[0]).toMatchObject({
      workspaceId,
      paneId,
      surfaceId,
      providerSessionId
    });
    expect(second.findBySurface(surfaceId.toUpperCase())?.surfaceId).toBe(surfaceId);

    await second.forgetProviderSession(surfaceId.toUpperCase());
    expect(second.listProviderSessions()).toEqual([]);
    await second.detach(surfaceId.toUpperCase());
    expect(second.list()).toEqual([]);
  });
});
