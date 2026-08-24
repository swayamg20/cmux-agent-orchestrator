import { Notice, Plugin } from "obsidian";
import { AgentCockpitController } from "./app/AgentCockpitController";
import { AgentCockpitSettingsTab } from "./settings/AgentCockpitSettingsTab";
import { AGENT_COCKPIT_VIEW_TYPE, AgentCockpitView } from "./views/AgentCockpitView";

export default class AgentCockpitPlugin extends Plugin {
  private controller: AgentCockpitController | null = null;

  override async onload(): Promise<void> {
    this.controller = new AgentCockpitController(this.app, this);
    this.registerView(AGENT_COCKPIT_VIEW_TYPE, (leaf) => new AgentCockpitView(leaf, this.requireController()));
    this.addRibbonIcon("layout-dashboard", "Open Agent Cockpit", () => void this.activateView());
    this.addCommand({
      id: "open-agent-cockpit",
      name: "Open Agent Cockpit",
      callback: () => void this.activateView()
    });
    this.addCommand({
      id: "refresh-agent-cockpit",
      name: "Refresh Agent Cockpit",
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
      new Notice(error instanceof Error ? error.message : "Agent Cockpit could not initialize.");
    }
  }

  override onunload(): void {
    this.controller?.dispose();
    this.controller = null;
    this.app.workspace.detachLeavesOfType(AGENT_COCKPIT_VIEW_TYPE);
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
    if (this.controller === null) throw new Error("Agent Cockpit has been unloaded.");
    return this.controller;
  }
}
