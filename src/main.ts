import { Notice, Plugin } from "obsidian";
import { AgentCockpitController } from "./app/AgentCockpitController";
import { CmuxClient } from "./cmux/CmuxClient";
import { PRODUCT_NAME } from "./identity";
import { ProviderMetadataService } from "./providers/ProviderMetadataService";
import { AutomaticProviderSessionResolver } from "./providers/identity/AutomaticProviderSessionResolver";
import { AgentCockpitSettingsTab } from "./settings/AgentCockpitSettingsTab";
import { AGENT_COCKPIT_VIEW_TYPE, AgentCockpitView } from "./views/AgentCockpitView";

export default class AgentCockpitPlugin extends Plugin {
  private controller: AgentCockpitController | null = null;

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
    this.addRibbonIcon("layout-dashboard", `Open ${PRODUCT_NAME}`, () => void this.activateView());
    this.addCommand({
      id: "open",
      name: "Open orchestrator",
      callback: () => void this.activateView()
    });
    this.addCommand({
      id: "refresh",
      name: "Refresh orchestrator",
      callback: () => void this.requireController().refreshNow()
    });
    this.addSettingTab(new AgentCockpitSettingsTab(this.app, this, this.controller));

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        const folder = this.requireController().getSettings().taskFolder;
        if (file.path.startsWith(`${folder}/`)) void this.requireController().reloadTasks();
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
}
