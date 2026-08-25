import { Notice, PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
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

  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl).setName("Connection and storage").setHeading();
    const draft: AgentCockpitSettings = this.controller.getSettings();
    const connection = this.controller.store.getState().connection;

    new Setting(this.containerEl)
      .setName("cmux connection")
      .setDesc(connection.message)
      .addButton((button) =>
        button.setButtonText("Test connection").onClick(() => {
          button.setDisabled(true);
          void this.controller.testConnection().finally(() => button.setDisabled(false));
        })
      );

    new Setting(this.containerEl)
      .setName("cmux binary")
      .setDesc("Optional absolute path to an executable named cmux. This is a path, never a command string.")
      .addText((text) =>
        text
          .setPlaceholder("Auto-detect")
          .setValue(draft.cmuxBinaryPath)
          .onChange((value) => {
            draft.cmuxBinaryPath = value;
          })
      );

    new Setting(this.containerEl)
      .setName("Task folder")
      .setDesc("Vault-relative folder for durable Markdown task notes.")
      .addText((text) =>
        text.setValue(draft.taskFolder).onChange((value) => {
          draft.taskFolder = value;
        })
      );

    new Setting(this.containerEl)
      .setName("Preview lines")
      .setDesc("Displayed preview size for startup, explicit refresh, and expanded sessions. Preview text is never persisted.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ "30": "30 lines", "60": "60 lines", "80": "80 lines" })
          .setValue(String(draft.previewLines))
          .onChange((value) => {
            draft.previewLines = Number(value);
          })
      );

    new Setting(this.containerEl).addButton((button) =>
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
