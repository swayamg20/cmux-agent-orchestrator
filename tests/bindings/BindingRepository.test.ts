import { describe, expect, it } from "vitest";
import type { Plugin } from "obsidian";

import { BindingRepository } from "../../src/bindings/BindingRepository";

describe("BindingRepository", () => {
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

  it("migrates schema-v1 bindings to stable schema-v2 identities without losing the mapping", async () => {
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
      machines: Record<string, { bindings: { bindingId: string; runId: string }[]; runs: { runId: string }[] }>;
    };
    expect(saved.schemaVersion).toBe(2);
    expect(saved.machines["00000000000000000000"]?.bindings[0]).toMatchObject({
      bindingId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/)
    });
    expect(saved.machines["00000000000000000000"]?.runs).toHaveLength(1);
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
