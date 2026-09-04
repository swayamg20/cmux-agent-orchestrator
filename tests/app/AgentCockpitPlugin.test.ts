import type { App, PluginManifest, TAbstractFile } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const harness = vi.hoisted(() => ({
  controller: null as { dispose: () => void } | null,
  dispose: vi.fn(),
  initialize: vi.fn<() => Promise<void>>(),
  notices: [] as string[],
  observesTaskVaultPath: vi.fn<(path: string) => boolean>()
}));

vi.mock("obsidian", () => {
  class Plugin {
    app = {
      metadataCache: { on: vi.fn(() => ({})) },
      vault: { on: vi.fn(() => ({})) },
      workspace: {}
    };

    addCommand(): void {}
    addRibbonIcon(): void {}
    addSettingTab(): void {}
    registerEvent(): void {}
    registerView(): void {}
  }

  class Notice {
    constructor(message: unknown) {
      if (typeof message === "string") harness.notices.push(message);
    }
  }

  return { Notice, Plugin };
});

vi.mock("../../src/app/AgentCockpitController", () => ({
  AgentCockpitController: class {
    constructor() {
      harness.controller = this;
    }

    dispose(): void {
      harness.dispose();
    }

    observesTaskVaultPath(path: string): boolean {
      return harness.observesTaskVaultPath(path);
    }

    initialize(): Promise<void> {
      return harness.initialize();
    }

    async refreshNow(): Promise<void> {}
  }
}));

vi.mock("../../src/cmux/CmuxClient", () => ({ CmuxClient: { create: vi.fn() } }));
vi.mock("../../src/providers/ProviderMetadataService", () => ({
  ProviderMetadataService: class {}
}));
vi.mock("../../src/providers/identity/AutomaticProviderSessionResolver", () => ({
  AutomaticProviderSessionResolver: class {}
}));
vi.mock("../../src/settings/AgentCockpitSettingsTab", () => ({
  AgentCockpitSettingsTab: class {}
}));
vi.mock("../../src/views/AgentCockpitView", () => ({
  AGENT_COCKPIT_VIEW_TYPE: "cmux-agent-orchestrator",
  AgentCockpitView: class {}
}));

import AgentCockpitPlugin from "../../src/main";

function createPlugin(): AgentCockpitPlugin {
  return new AgentCockpitPlugin({} as App, {} as PluginManifest);
}

describe("AgentCockpitPlugin lifecycle", () => {
  beforeEach(() => {
    harness.controller = null;
    harness.dispose.mockReset();
    harness.initialize.mockReset().mockResolvedValue(undefined);
    harness.observesTaskVaultPath.mockReset().mockReturnValue(false);
    harness.notices.length = 0;
  });

  it("forwards the event filter to every task path observed by the controller", async () => {
    harness.observesTaskVaultPath.mockImplementation(
      (path) => path === "Previous Folder/Tasks/pending.md"
    );
    const plugin = createPlugin();
    await plugin.onload();
    const taskFolderAffected = (
      plugin as unknown as { taskFolderAffected: (path: string) => boolean }
    ).taskFolderAffected.bind(plugin);

    expect(taskFolderAffected("Previous Folder/Tasks/pending.md")).toBe(true);
    expect(taskFolderAffected("Unrelated/note.md")).toBe(false);
    expect(harness.observesTaskVaultPath).toHaveBeenNthCalledWith(
      1,
      "Previous Folder/Tasks/pending.md"
    );
  });

  it("does not report a late initialization failure after unload", async () => {
    const initialization = deferred<void>();
    harness.initialize.mockReturnValueOnce(initialization.promise);
    const plugin = createPlugin();

    const loading = plugin.onload();
    expect(harness.initialize).toHaveBeenCalledOnce();
    plugin.onunload();
    initialization.reject(new Error("Late initialization failure."));
    await loading;

    expect(harness.dispose).toHaveBeenCalledOnce();
    expect(harness.notices).toEqual([]);
  });

  it("does not report a queued task reload failure after unload", async () => {
    const reload = deferred<void>();
    const controller = {
      dispose: vi.fn(),
      reloadTasks: vi.fn(() => reload.promise)
    };
    const plugin = createPlugin();
    const testablePlugin = plugin as unknown as {
      controller: typeof controller | null;
      reloadTasksFromVaultEvent: (file: TAbstractFile) => void;
    };
    const file = { path: "Agent Work/Tasks/example.md" } as TAbstractFile;
    testablePlugin.controller = controller;

    testablePlugin.reloadTasksFromVaultEvent(file);
    file.path = "Agent Work/Tasks/renamed.md";
    await Promise.resolve();
    expect(controller.reloadTasks).toHaveBeenCalledWith([
      { file, path: "Agent Work/Tasks/example.md" }
    ], []);

    plugin.onunload();
    reload.reject(new Error("Late task reload failure."));
    await reload.promise.catch(() => undefined);
    await Promise.resolve();

    expect(controller.dispose).toHaveBeenCalledOnce();
    expect(harness.notices).toEqual([]);
  });

  it("forwards exact rename evidence as one batch separate from generic invalidation", async () => {
    const controller = {
      dispose: vi.fn(),
      reloadTasks: vi.fn(async () => undefined)
    };
    const plugin = createPlugin();
    const testablePlugin = plugin as unknown as {
      controller: typeof controller | null;
      reloadTasksFromRenameEvent: (file: TAbstractFile, oldPath: string) => void;
    };
    const firstFile = { path: "Agent Work/Tasks/second.md" } as TAbstractFile;
    const secondFile = { path: "Agent Work/Tasks/first.md" } as TAbstractFile;
    testablePlugin.controller = controller;

    testablePlugin.reloadTasksFromRenameEvent(firstFile, "Agent Work/Tasks/first.md");
    testablePlugin.reloadTasksFromRenameEvent(secondFile, "Agent Work/Tasks/second.md");
    await Promise.resolve();

    expect(controller.reloadTasks).toHaveBeenCalledOnce();
    expect(controller.reloadTasks).toHaveBeenCalledWith([], [
      { file: firstFile, oldPath: "Agent Work/Tasks/first.md" },
      { file: secondFile, oldPath: "Agent Work/Tasks/second.md" }
    ]);
  });

  it("does not reveal a newly prepared view after unload", async () => {
    const viewState = deferred<void>();
    const leaf = { setViewState: vi.fn(() => viewState.promise) };
    const revealLeaf = vi.fn(async () => undefined);
    const plugin = createPlugin();
    await plugin.onload();
    const testablePlugin = plugin as unknown as {
      activateView: () => Promise<void>;
      app: {
        workspace: {
          getLeaf: () => typeof leaf;
          getLeavesOfType: () => [];
          revealLeaf: typeof revealLeaf;
        };
      };
    };
    testablePlugin.app.workspace = {
      getLeaf: () => leaf,
      getLeavesOfType: () => [],
      revealLeaf
    };

    const activation = testablePlugin.activateView();
    expect(leaf.setViewState).toHaveBeenCalledOnce();
    plugin.onunload();
    viewState.resolve(undefined);
    await activation;

    expect(revealLeaf).not.toHaveBeenCalled();
  });

  it("suppresses an in-flight view failure after unload", async () => {
    const reveal = deferred<void>();
    const leaf = { setViewState: vi.fn(async () => undefined) };
    const revealLeaf = vi.fn(() => reveal.promise);
    const plugin = createPlugin();
    await plugin.onload();
    const testablePlugin = plugin as unknown as {
      activateView: () => Promise<void>;
      app: {
        workspace: {
          getLeaf: () => typeof leaf;
          getLeavesOfType: () => [typeof leaf];
          revealLeaf: typeof revealLeaf;
        };
      };
    };
    testablePlugin.app.workspace = {
      getLeaf: () => leaf,
      getLeavesOfType: () => [leaf],
      revealLeaf
    };

    const activation = testablePlugin.activateView();
    expect(revealLeaf).toHaveBeenCalledWith(leaf);
    plugin.onunload();
    reveal.reject(new Error("Late view failure."));

    await expect(activation).resolves.toBeUndefined();
  });
});
