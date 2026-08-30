import {
  Notice,
  PluginSettingTab,
  Setting,
  type App,
  type Plugin,
  type SettingDefinitionItem
} from "obsidian";
import type { AgentCockpitController } from "../app/AgentCockpitController";
import { PRODUCT_NAME } from "../identity";
import type { AgentCockpitSettings } from "./AgentCockpitSettings";

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
            name: "Preview lines",
            desc: "Displayed preview size for startup, explicit refresh, and expanded sessions. Preview text is never persisted.",
            aliases: ["terminal preview", "screen lines"],
            render: (setting) => this.addPreviewLinesDropdown(setting, getDraft())
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

    this.addPreviewLinesDropdown(
      new Setting(this.containerEl)
        .setName("Preview lines")
        .setDesc("Displayed preview size for startup, explicit refresh, and expanded sessions. Preview text is never persisted."),
      draft
    );

    this.addSaveButton(new Setting(this.containerEl), draft);
  }

  private addConnectionButton(setting: Setting): void {
    setting.addButton((button) =>
      button.setButtonText("Test connection").onClick(() => {
        button.setDisabled(true);
        void this.controller.testConnection().finally(() => button.setDisabled(false));
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

  private addSaveButton(setting: Setting, draft: AgentCockpitSettings): void {
    setting.addButton((button) =>
      button
        .setCta()
        .setButtonText("Save settings")
        .onClick(() => {
          button.setDisabled(true);
          void this.controller
            .updateSettings(draft)
            .then(() => new Notice(`${PRODUCT_NAME} settings saved.`))
            .catch((error: unknown) => new Notice(error instanceof Error ? error.message : "Could not save settings."))
            .finally(() => button.setDisabled(false));
        })
    );
  }
}
