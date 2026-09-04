import type { App, Plugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { AgentCockpitController } from "../../src/app/AgentCockpitController";
import { AgentCockpitSettingsTab } from "../../src/settings/AgentCockpitSettingsTab";

describe("AgentCockpitSettingsTab", () => {
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
          { name: "Preview lines" },
          { name: "Stale working threshold" },
          { name: "Save settings", searchable: false }
        ]
      }
    ]);
  });
});
