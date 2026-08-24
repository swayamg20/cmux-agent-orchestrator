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
    await expect(repository.attach(binding)).resolves.toBeUndefined();
    expect(repository.list()).toHaveLength(1);
  });
});
