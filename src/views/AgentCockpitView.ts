import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import type { AgentCockpitController } from "../app/AgentCockpitController";
import { renderCmuxConnectionPanel } from "../components/CmuxConnectionPanel";
import type { SessionCardActions } from "../components/SessionCard";
import { renderConnectionBadge } from "../components/StatusBadge";
import type { CockpitState } from "../state/types";
import { renderKanbanPanel } from "./KanbanPanel";
import { renderNeedsAttentionPanel } from "./NeedsAttentionPanel";
import {
  COCKPIT_SECTIONS,
  sectionForNavigationKey,
  type CockpitSection
} from "./CockpitNavigation";
import { renderSessionInbox } from "./SessionInbox";
import { selectSessionInbox } from "./SessionInboxModel";
import { renderSessionsPanel } from "./SessionsView";

export const AGENT_COCKPIT_VIEW_TYPE = "agent-cockpit-view";

export class AgentCockpitView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private readonly expanded = new Set<string>();
  private activeSection: CockpitSection = "work";
  private pendingFocusKey: string | null = null;
  private showAllInbox = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly controller: AgentCockpitController
  ) {
    super(leaf);
    this.navigation = false;
  }

  getViewType(): string {
    return AGENT_COCKPIT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Agent Cockpit";
  }

  override getIcon(): string {
    return "layout-dashboard";
  }

  protected override async onOpen(): Promise<void> {
    this.contentEl.addClass("agent-cockpit-view-content");
    this.unsubscribe = this.controller.store.subscribe((state) => this.render(state));
  }

  protected override async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.contentEl.empty();
  }

  private render(state: Readonly<CockpitState>): void {
    const active = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
    const focusKey = this.pendingFocusKey ?? active?.dataset.focusKey ?? null;
    this.pendingFocusKey = null;
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "agent-cockpit" });
    renderHeader(root, state, this.controller);
    renderCmuxConnectionPanel(root, state.connection, state.refreshing, {
      retry: () => void this.controller.testConnection(),
      copySetupSteps: () => void this.controller.copyCmuxSetupSteps()
    });
    this.renderSectionTabs(root, state);
    const panel = this.renderSectionPanels(root);
    const sessionActions = this.sessionActions();
    if (this.activeSection === "work") {
      renderNeedsAttentionPanel(panel, state, this.expanded, {
        ...sessionActions,
        openTask: (task) => void this.controller.openTask(task)
      });
      renderKanbanPanel(panel, state, {
        createTask: () => this.controller.showCreateTask(null),
        openTask: (task) => void this.controller.openTask(task),
        moveTask: (task, status) => void this.controller.updateWorkflow(task, status)
      });
    } else if (this.activeSection === "agents") {
      renderSessionInbox(panel, state, this.showAllInbox, {
        ...sessionActions,
        setShowAll: (showAll) => {
          this.showAllInbox = showAll;
          this.render(this.controller.store.getState());
        }
      });
    } else {
      renderSessionsPanel(panel, state, this.expanded, {
        ...sessionActions,
        setFilter: (patch) => this.controller.setFilters(patch)
      });
    }
    if (focusKey) {
      const next = this.contentEl.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`);
      next?.focus({ preventScroll: true });
    }
  }

  private sessionActions(): SessionCardActions {
    return {
      loadPreview: (session) => void this.controller.loadPreview(session),
      focus: (session) => void this.controller.focusSession(session),
      openTask: (task) => void this.controller.openTask(task),
      attachTask: (session) => this.controller.showTaskPicker(session),
      createTask: (session) => this.controller.showCreateTask(session),
      detachTask: (session) => void this.controller.detachTask(session),
      copyMetadata: (session) => void this.controller.copyMetadata(session)
    };
  }

  private renderSectionTabs(container: HTMLElement, state: Readonly<CockpitState>): void {
    const untrackedRuns = selectSessionInbox(state, null).total;
    const counts: Record<CockpitSection, number> = {
      work: state.tasks.length,
      agents: untrackedRuns,
      cmux: state.sessions.length
    };
    const countLabels: Record<CockpitSection, string> = {
      work: "durable tasks",
      agents: "untracked agent runs",
      cmux: "cmux surfaces"
    };
    const labels: Record<CockpitSection, string> = {
      work: "Work",
      agents: "Agent runs",
      cmux: "cmux"
    };
    const icons: Record<CockpitSection, string> = {
      work: "list-checks",
      agents: "bot",
      cmux: "square-terminal"
    };

    const tabs = container.createDiv({
      cls: "agent-cockpit-mode-tabs",
      attr: { role: "tablist", "aria-label": "Agent Cockpit sections" }
    });
    for (const section of COCKPIT_SECTIONS) {
      const selected = section === this.activeSection;
      const tab = tabs.createEl("button", {
        cls: "agent-cockpit-mode-tab",
        attr: {
          type: "button",
          id: `agent-cockpit-tab-${section}`,
          role: "tab",
          "aria-selected": String(selected),
          "aria-controls": `agent-cockpit-panel-${section}`,
          tabindex: selected ? "0" : "-1",
          "data-focus-key": `mode-${section}`
        }
      });
      const icon = tab.createSpan({ cls: "agent-cockpit-mode-tab-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, icons[section]);
      tab.createSpan({ text: labels[section] });
      tab.createSpan({
        cls: "agent-cockpit-mode-tab-count",
        text: String(counts[section]),
        attr: { "aria-label": `${counts[section]} ${countLabels[section]}` }
      });
      if (section === "work" && state.attention.length > 0) {
        tab.createSpan({
          cls: "agent-cockpit-mode-tab-alert",
          attr: {
            title: `${state.attention.length} ${state.attention.length === 1 ? "item needs" : "items need"} attention`,
            role: "img",
            "aria-label": `${state.attention.length} ${state.attention.length === 1 ? "item needs" : "items need"} attention`
          }
        });
      }
      tab.addEventListener("click", () => this.activateSection(section));
      tab.addEventListener("keydown", (event) => {
        const destination = sectionForNavigationKey(section, event.key);
        if (destination === null) return;
        event.preventDefault();
        this.activateSection(destination);
      });
    }
  }

  private renderSectionPanels(container: HTMLElement): HTMLElement {
    const host = container.createEl("main", { cls: "agent-cockpit-mode-host" });
    let activePanel: HTMLElement | null = null;
    for (const section of COCKPIT_SECTIONS) {
      const selected = section === this.activeSection;
      const panel = host.createEl("section", {
        cls: `agent-cockpit-mode-panel agent-cockpit-mode-panel--${section}`,
        attr: {
          id: `agent-cockpit-panel-${section}`,
          role: "tabpanel",
          "aria-labelledby": `agent-cockpit-tab-${section}`,
          tabindex: selected ? "0" : "-1"
        }
      });
      panel.hidden = !selected;
      if (selected) activePanel = panel;
    }
    if (activePanel === null) throw new Error("Agent Cockpit could not resolve its active section.");
    return activePanel;
  }

  private activateSection(section: CockpitSection): void {
    this.activeSection = section;
    this.pendingFocusKey = `mode-${section}`;
    this.render(this.controller.store.getState());
  }
}

function renderHeader(
  container: HTMLElement,
  state: Readonly<CockpitState>,
  controller: AgentCockpitController
): void {
  const header = container.createEl("header", { cls: "agent-cockpit-header" });
  const identity = header.createDiv({ cls: "agent-cockpit-heading-group" });
  const titleLine = identity.createDiv({ cls: "agent-cockpit-heading-line" });
  titleLine.createEl("h1", { text: "Agent Cockpit" });
  renderConnectionBadge(titleLine, state.connection);
  const actions = header.createDiv({ cls: "agent-cockpit-header-actions" });
  const create = actions.createEl("button", { attr: { type: "button", "aria-label": "Create task" } });
  setIcon(create, "file-plus-2");
  create.createSpan({ text: "New task" });
  create.addEventListener("click", () => controller.showCreateTask(null));
  const refresh = actions.createEl("button", {
    attr: {
      type: "button",
      "aria-label": state.refreshing ? "Refreshing Agent Cockpit" : "Refresh Agent Cockpit",
      title: "Refresh topology, notifications, and bounded session evidence"
    }
  });
  setIcon(refresh, "refresh-cw");
  refresh.createSpan({ text: state.refreshing ? "Refreshing" : "Refresh" });
  refresh.disabled = state.refreshing;
  refresh.addEventListener("click", () => void controller.refreshNow());
}
