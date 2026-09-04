import {
  Notice,
  PluginSettingTab,
  Setting,
  type App,
  type Plugin,
  type SettingDefinitionItem
} from "obsidian";
import type { AgentCockpitController } from "../app/AgentCockpitController";
import { runUiAction } from "../app/runUiAction";
import { PRODUCT_NAME } from "../identity";
import type { AgentCockpitSettings } from "./AgentCockpitSettings";

const PREVIEW_LINES_DESCRIPTION =
  "Number of lines shown when a session is expanded or its preview is explicitly refreshed. Preview text stays in memory and is never persisted.";

export class AgentCockpitSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly controller: AgentCockpitController
  ) {
    super(app, plugin);
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    let draft: AgentCockpitSettings | null = null;
    const getDraft = (): AgentCockpitSettings => (draft ??= this.controller.getSettings());
    const connection = this.controller.store.getState().connection;

    return [
      {
        type: "group",
        heading: "Connection and storage",
        items: [
          {
            name: "cmux connection",
            desc: connection.message,
            aliases: ["connection status", "test connection"],
            render: (setting) => this.addConnectionButton(setting)
          },
          {
            name: "cmux binary",
            desc: "Optional absolute path to an executable named cmux. This is a path, never a command string.",
            aliases: ["cmux path", "executable"],
            render: (setting) => this.addBinaryInput(setting, getDraft())
          },
          {
            name: "Task folder",
            desc: "Vault-relative folder for durable Markdown task notes.",
            aliases: ["task notes", "storage folder"],
            render: (setting) => this.addTaskFolderInput(setting, getDraft())
          },
          {
            name: "Automatically track agent runs",
            desc: "Create one active Markdown task for each newly discovered, exact Claude or Codex session. Ambiguous sessions remain available for manual tracking.",
            aliases: ["automatic tasks", "auto track", "work board"],
            render: (setting) => this.addAutomaticTrackingToggle(setting, getDraft())
          },
          {
            name: "Preview lines",
            desc: PREVIEW_LINES_DESCRIPTION,
            aliases: ["terminal preview", "screen lines"],
            render: (setting) => this.addPreviewLinesDropdown(setting, getDraft())
          },
          {
            name: "Stale working threshold",
            desc: "Show an attention signal when structured lifecycle evidence still reports working but no activity has been observed for this long.",
            aliases: ["stale agent", "attention timeout", "working timeout"],
            render: (setting) => this.addStaleThresholdDropdown(setting, getDraft())
          },
          {
            name: "Save settings",
            desc: "Validate and persist the connection and storage settings.",
            searchable: false,
            render: (setting) => this.addSaveButton(setting, getDraft())
          }
        ]
      }
    ];
  }

  override display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl).setName("Connection and storage").setHeading();
    const draft: AgentCockpitSettings = this.controller.getSettings();
    const connection = this.controller.store.getState().connection;

    this.addConnectionButton(
      new Setting(this.containerEl).setName("cmux connection").setDesc(connection.message)
    );

    this.addBinaryInput(
      new Setting(this.containerEl)
        .setName("cmux binary")
        .setDesc("Optional absolute path to an executable named cmux. This is a path, never a command string."),
      draft
    );

    this.addTaskFolderInput(
      new Setting(this.containerEl)
        .setName("Task folder")
        .setDesc("Vault-relative folder for durable Markdown task notes."),
      draft
    );

    this.addAutomaticTrackingToggle(
      new Setting(this.containerEl)
        .setName("Automatically track agent runs")
        .setDesc(
          "Create one active Markdown task for each newly discovered, exact Claude or Codex session. Ambiguous sessions remain available for manual tracking."
        ),
      draft
    );

    this.addPreviewLinesDropdown(
      new Setting(this.containerEl)
        .setName("Preview lines")
        .setDesc(PREVIEW_LINES_DESCRIPTION),
      draft
    );

    this.addStaleThresholdDropdown(
      new Setting(this.containerEl)
        .setName("Stale working threshold")
        .setDesc(
          "Show an attention signal when structured lifecycle evidence still reports working but no activity has been observed for this long."
        ),
      draft
    );

    this.addSaveButton(new Setting(this.containerEl), draft);
  }

  private addConnectionButton(setting: Setting): void {
    setting.addButton((button) =>
      button.setButtonText("Test connection").onClick(() => {
        if (this.controller.isDisposed()) return;
        button.setDisabled(true);
        void runUiAction(
          () => this.controller.testConnection(),
          "Could not test the cmux connection.",
          () => !this.controller.isDisposed()
        ).finally(() => {
          if (!this.controller.isDisposed()) button.setDisabled(false);
        });
      })
    );
  }

  private addBinaryInput(setting: Setting, draft: AgentCockpitSettings): void {
    setting.addText((text) =>
      text
        .setPlaceholder("Auto-detect")
        .setValue(draft.cmuxBinaryPath)
        .onChange((value) => {
          draft.cmuxBinaryPath = value;
        })
    );
  }

  private addTaskFolderInput(setting: Setting, draft: AgentCockpitSettings): void {
    setting.addText((text) =>
      text.setValue(draft.taskFolder).onChange((value) => {
        draft.taskFolder = value;
      })
    );
  }

  private addAutomaticTrackingToggle(setting: Setting, draft: AgentCockpitSettings): void {
    setting.addToggle((toggle) =>
      toggle.setValue(draft.autoTrackAgentRuns).onChange((value) => {
        draft.autoTrackAgentRuns = value;
      })
    );
  }

  private addPreviewLinesDropdown(setting: Setting, draft: AgentCockpitSettings): void {
    setting.addDropdown((dropdown) =>
      dropdown
        .addOptions({ "30": "30 lines", "60": "60 lines", "80": "80 lines" })
        .setValue(String(draft.previewLines))
        .onChange((value) => {
          draft.previewLines = Number(value);
        })
    );
  }

  private addStaleThresholdDropdown(setting: Setting, draft: AgentCockpitSettings): void {
    const options: Record<string, string> = {
      "900000": "15 minutes",
      "1800000": "30 minutes",
      "3600000": "1 hour",
      "7200000": "2 hours",
      "14400000": "4 hours",
      "28800000": "8 hours",
      "86400000": "24 hours"
    };
    const current = String(draft.staleAfterMs);
    if (!(current in options)) options[current] = `Current (${formatDuration(draft.staleAfterMs)})`;
    setting.addDropdown((dropdown) =>
      dropdown
        .addOptions(options)
        .setValue(current)
        .onChange((value) => {
          draft.staleAfterMs = Number(value);
        })
    );
  }

  private addSaveButton(setting: Setting, draft: AgentCockpitSettings): void {
    setting.addButton((button) =>
      button
        .setCta()
        .setButtonText("Save settings")
        .onClick(() => {
          if (this.controller.isDisposed()) return;
          button.setDisabled(true);
          void this.controller
            .updateSettings(draft)
            .then(() => {
              if (!this.controller.isDisposed()) new Notice(`${PRODUCT_NAME} settings saved.`);
            })
            .catch((error: unknown) => {
              if (!this.controller.isDisposed()) {
                new Notice(error instanceof Error ? error.message : "Could not save settings.");
              }
            })
            .finally(() => {
              if (!this.controller.isDisposed()) button.setDisabled(false);
            });
        })
    );
  }
}

function formatDuration(durationMs: number): string {
  const minutes = Math.round(durationMs / 60_000);
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
