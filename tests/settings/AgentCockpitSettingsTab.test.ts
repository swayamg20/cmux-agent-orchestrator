import { Notice, Setting, type App, type Plugin } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCockpitController } from "../../src/app/AgentCockpitController";
import { DEFAULT_SETTINGS, type AgentCockpitSettings } from "../../src/settings/AgentCockpitSettings";
import { AgentCockpitSettingsTab } from "../../src/settings/AgentCockpitSettingsTab";

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

describe("AgentCockpitSettingsTab", () => {
  beforeEach(() => {
    (Notice as unknown as { messages: string[] }).messages.length = 0;
  });

  it("exposes searchable setting definitions without reading settings during registration", () => {
    const getSettings = vi.fn(() => {
      throw new Error("Settings should remain lazy during search indexing.");
    });
    const controller = {
      getSettings,
      store: {
        getState: () => ({ connection: { message: "cmux connected" } })
      }
    } as unknown as AgentCockpitController;
    const tab = new AgentCockpitSettingsTab({} as App, {} as Plugin, controller);

    const definitions = tab.getSettingDefinitions();

    expect(getSettings).not.toHaveBeenCalled();
    expect(definitions).toHaveLength(1);
    expect(definitions).toMatchObject([
      {
        type: "group",
        heading: "Connection and storage",
        items: [
          { name: "cmux connection" },
          { name: "cmux binary" },
          { name: "Task folder" },
          { name: "Automatically track agent runs" },
          { name: "Workflow automation" },
          {
            name: "Preview lines",
            desc: "Number of lines shown when a session is expanded or its preview is explicitly refreshed. Preview text stays in memory and is never persisted."
          },
          { name: "Stale working threshold" },
          { name: "Save settings", searchable: false }
        ]
      }
    ]);
  });

  it("renders an initialization failure without reading or saving unavailable settings", () => {
    const getSettings = vi.fn(() => {
      throw new Error("Strict settings access must not run after initialization fails.");
    });
    const controller = {
      getLoadedSettings: () => null,
      getSettings,
      store: {
        getState: () => ({
          connection: { message: "Could not initialize cmux Agent Orchestrator." },
          error: "Could not initialize cmux Agent Orchestrator: Plugin data is unavailable."
        })
      }
    } as unknown as AgentCockpitController;
    const tab = new AgentCockpitSettingsTab({} as App, {} as Plugin, controller);
    const instanceStart = (Setting as unknown as { instances: Setting[] }).instances.length;
    (tab as unknown as { containerEl: { empty: () => void } }).containerEl = {
      empty: vi.fn()
    };

    const renderClassicSettings = (tab as unknown as { display: () => void }).display.bind(tab);
    expect(() => renderClassicSettings()).not.toThrow();

    const displayed = (Setting as unknown as { instances: Setting[] }).instances.slice(instanceStart);
    expect(displayed.at(-1)).toMatchObject({
      name: "Settings unavailable",
      description:
        "Could not initialize cmux Agent Orchestrator: Plugin data is unavailable. Reload the plugin after resolving the error; no settings were changed."
    });
    expect(getSettings).not.toHaveBeenCalled();

    const definitions = tab.getSettingDefinitions();
    const items = (definitions[0] as { items: Array<{ render?: (setting: Setting) => void }> }).items;
    for (const item of items) {
      const setting = new Setting({} as HTMLElement);
      expect(() => item.render?.(setting)).not.toThrow();
      expect(setting).toMatchObject({
        description:
          "Could not initialize cmux Agent Orchestrator: Plugin data is unavailable. Reload the plugin after resolving the error; no settings were changed.",
        buttons: [],
        dropdowns: [],
        texts: [],
        toggles: []
      });
    }
    expect(getSettings).not.toHaveBeenCalled();
  });

  it("does not publish a settings-save completion after controller disposal", async () => {
    const save = deferred<void>();
    let disposed = false;
    const controller = {
      isDisposed: () => disposed,
      updateSettings: vi.fn(() => save.promise)
    } as unknown as AgentCockpitController;
    const tab = new AgentCockpitSettingsTab({} as App, {} as Plugin, controller);
    let click: (() => void) | null = null;
    const button = {
      onClick: vi.fn((callback: () => void) => {
        click = callback;
        return button;
      }),
      setButtonText: vi.fn(() => button),
      setCta: vi.fn(() => button),
      setDisabled: vi.fn(() => button)
    };
    const setting = {
      addButton: (build: (target: typeof button) => void) => {
        build(button);
        return setting;
      }
    } as unknown as Setting;
    const testableTab = tab as unknown as {
      addSaveButton: (target: Setting, draft: AgentCockpitSettings) => void;
    };
    testableTab.addSaveButton(setting, { ...DEFAULT_SETTINGS });

    expect(click).not.toBeNull();
    (click as unknown as () => void)();
    expect(button.setDisabled).toHaveBeenCalledWith(true);
    disposed = true;
    save.resolve(undefined);
    await save.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect((Notice as unknown as { messages: string[] }).messages).toEqual([]);
    expect(button.setDisabled).toHaveBeenCalledTimes(1);
  });

  it("does not publish a connection-test failure after controller disposal", async () => {
    const connectionTest = deferred<void>();
    let disposed = false;
    const controller = {
      isDisposed: () => disposed,
      testConnection: vi.fn(() => connectionTest.promise)
    } as unknown as AgentCockpitController;
    const tab = new AgentCockpitSettingsTab({} as App, {} as Plugin, controller);
    let click: (() => void) | null = null;
    const button = {
      onClick: vi.fn((callback: () => void) => {
        click = callback;
        return button;
      }),
      setButtonText: vi.fn(() => button),
      setDisabled: vi.fn(() => button)
    };
    const setting = {
      addButton: (build: (target: typeof button) => void) => {
        build(button);
        return setting;
      }
    } as unknown as Setting;
    const testableTab = tab as unknown as {
      addConnectionButton: (target: Setting) => void;
    };
    testableTab.addConnectionButton(setting);

    expect(click).not.toBeNull();
    (click as unknown as () => void)();
    expect(button.setDisabled).toHaveBeenCalledWith(true);
    disposed = true;
    connectionTest.reject(new Error("Late connection failure."));
    await connectionTest.promise.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect((Notice as unknown as { messages: string[] }).messages).toEqual([]);
    expect(button.setDisabled).toHaveBeenCalledTimes(1);
  });
});
