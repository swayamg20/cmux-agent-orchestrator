import { Notice, Plugin } from "obsidian";
import { AgentCockpitController } from "./app/AgentCockpitController";
import { runUiAction } from "./app/runUiAction";
import { CmuxClient } from "./cmux/CmuxClient";
import { PRODUCT_NAME } from "./identity";
import { ProviderMetadataService } from "./providers/ProviderMetadataService";
import { AutomaticProviderSessionResolver } from "./providers/identity/AutomaticProviderSessionResolver";
import { AgentCockpitSettingsTab } from "./settings/AgentCockpitSettingsTab";
import { pathAffectsTaskFolder } from "./tasks/TaskFolderEvents";
import { AGENT_COCKPIT_VIEW_TYPE, AgentCockpitView } from "./views/AgentCockpitView";

export default class AgentCockpitPlugin extends Plugin {
  private controller: AgentCockpitController | null = null;
  private taskReloadQueued = false;

  override async onload(): Promise<void> {
    const providerMetadata = new ProviderMetadataService();
    this.controller = new AgentCockpitController(
      this.app,
      this,
      (explicitBinaryPath) => CmuxClient.create(explicitBinaryPath),
      providerMetadata,
      new AutomaticProviderSessionResolver(providerMetadata)
    );
    this.registerView(AGENT_COCKPIT_VIEW_TYPE, (leaf) => new AgentCockpitView(leaf, this.requireController()));
    this.addRibbonIcon("layout-dashboard", `Open ${PRODUCT_NAME}`, () => {
      void runUiAction(() => this.activateView(), `Could not open ${PRODUCT_NAME}.`);
    });
    this.addCommand({
      id: "open",
      name: "Open orchestrator",
      callback: () => void runUiAction(
        () => this.activateView(),
        `Could not open ${PRODUCT_NAME}.`
      )
    });
    this.addCommand({
      id: "refresh",
      name: "Refresh orchestrator",
      callback: () => void runUiAction(
        () => this.requireController().refreshNow(),
        `Could not refresh ${PRODUCT_NAME}.`
      )
    });
    this.addSettingTab(new AgentCockpitSettingsTab(this.app, this, this.controller));

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (this.taskFolderAffected(file.path)) this.reloadTasksFromVaultEvent();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.taskFolderAffected(file.path)) this.reloadTasksFromVaultEvent();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.taskFolderAffected(file.path) || this.taskFolderAffected(oldPath)) {
          this.reloadTasksFromVaultEvent();
        }
      })
    );

    try {
      await this.controller.initialize();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : `${PRODUCT_NAME} could not initialize.`);
    }
  }

  override onunload(): void {
    this.controller?.dispose();
    this.controller = null;
  }

  private async activateView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(AGENT_COCKPIT_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: AGENT_COCKPIT_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  private requireController(): AgentCockpitController {
    if (this.controller === null) throw new Error(`${PRODUCT_NAME} has been unloaded.`);
    return this.controller;
  }

  private taskFolderAffected(path: string): boolean {
    const controller = this.controller;
    return controller !== null && pathAffectsTaskFolder(path, controller.getSettings().taskFolder);
  }

  private reloadTasksFromVaultEvent(): void {
    if (this.taskReloadQueued) return;
    this.taskReloadQueued = true;
    queueMicrotask(() => {
      this.taskReloadQueued = false;
      const controller = this.controller;
      if (controller === null) return;
      void controller.reloadTasks().catch((error: unknown) => {
        new Notice(error instanceof Error ? error.message : "Could not refresh agent task notes.");
      });
    });
  }
}
