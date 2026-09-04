import { Notice, Plugin, type TAbstractFile } from "obsidian";
import { AgentCockpitController } from "./app/AgentCockpitController";
import { runUiAction } from "./app/runUiAction";
import { CmuxClient } from "./cmux/CmuxClient";
import { PRODUCT_NAME } from "./identity";
import { ProviderMetadataService } from "./providers/ProviderMetadataService";
import { AutomaticProviderSessionResolver } from "./providers/identity/AutomaticProviderSessionResolver";
import { AgentCockpitSettingsTab } from "./settings/AgentCockpitSettingsTab";
import { pathAffectsTaskFolder } from "./tasks/TaskFolderEvents";
import type {
  TaskInvalidationEvidence,
  TaskRenameEvidence
} from "./tasks/TaskRepository";
import { AGENT_COCKPIT_VIEW_TYPE, AgentCockpitView } from "./views/AgentCockpitView";

export default class AgentCockpitPlugin extends Plugin {
  private controller: AgentCockpitController | null = null;
  private taskReloadQueued = false;
  private readonly pendingTaskInvalidations = new Map<TAbstractFile, string>();
  private readonly pendingTaskRenames = new Map<TAbstractFile, string>();

  override async onload(): Promise<void> {
    const providerMetadata = new ProviderMetadataService();
    const controller = new AgentCockpitController(
      this.app,
      this,
      (explicitBinaryPath) => CmuxClient.create(explicitBinaryPath),
      providerMetadata,
      new AutomaticProviderSessionResolver(providerMetadata)
    );
    this.controller = controller;
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
    this.addSettingTab(new AgentCockpitSettingsTab(this.app, this, controller));

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (this.taskFolderAffected(file.path)) this.reloadTasksFromVaultEvent(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.taskFolderAffected(file.path)) this.reloadTasksFromVaultEvent(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.taskFolderAffected(file.path) || this.taskFolderAffected(oldPath)) {
          this.reloadTasksFromRenameEvent(file, oldPath);
        }
      })
    );

    try {
      await controller.initialize();
    } catch (error) {
      if (this.controller !== controller) return;
      new Notice(error instanceof Error ? error.message : `${PRODUCT_NAME} could not initialize.`);
    }
  }

  override onunload(): void {
    const controller = this.controller;
    this.controller = null;
    this.taskReloadQueued = false;
    this.pendingTaskInvalidations.clear();
    this.pendingTaskRenames.clear();
    controller?.dispose();
  }

  private async activateView(): Promise<void> {
    const controller = this.requireController();
    try {
      let leaf = this.app.workspace.getLeavesOfType(AGENT_COCKPIT_VIEW_TYPE)[0];
      if (!leaf) {
        leaf = this.app.workspace.getLeaf("tab");
        await leaf.setViewState({ type: AGENT_COCKPIT_VIEW_TYPE, active: true });
        if (this.controller !== controller) return;
      }
      await this.app.workspace.revealLeaf(leaf);
    } catch (error) {
      if (this.controller !== controller) return;
      throw error;
    }
  }

  private requireController(): AgentCockpitController {
    if (this.controller === null) throw new Error(`${PRODUCT_NAME} has been unloaded.`);
    return this.controller;
  }

  private taskFolderAffected(path: string): boolean {
    const controller = this.controller;
    const taskFolder = controller?.getLoadedTaskFolder() ?? null;
    return taskFolder !== null && pathAffectsTaskFolder(path, taskFolder);
  }

  private reloadTasksFromVaultEvent(file: TAbstractFile): void {
    if (!this.pendingTaskInvalidations.has(file)) {
      this.pendingTaskInvalidations.set(file, file.path);
    }
    this.queueTaskReload();
  }

  private reloadTasksFromRenameEvent(file: TAbstractFile, oldPath: string): void {
    if (!this.pendingTaskRenames.has(file)) this.pendingTaskRenames.set(file, oldPath);
    this.queueTaskReload();
  }

  private queueTaskReload(): void {
    if (this.taskReloadQueued) return;
    this.taskReloadQueued = true;
    queueMicrotask(() => {
      this.taskReloadQueued = false;
      const invalidations: TaskInvalidationEvidence[] = [...this.pendingTaskInvalidations]
        .map(([file, path]) => ({ file, path }));
      const renames: TaskRenameEvidence[] = [...this.pendingTaskRenames]
        .map(([file, oldPath]) => ({ file, oldPath }));
      this.pendingTaskInvalidations.clear();
      this.pendingTaskRenames.clear();
      const controller = this.controller;
      if (controller === null) return;
      void controller.reloadTasks(invalidations, renames).catch((error: unknown) => {
        if (this.controller !== controller) return;
        new Notice(error instanceof Error ? error.message : "Could not refresh agent task notes.");
      });
    });
  }
}
