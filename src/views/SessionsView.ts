import type { CockpitState, ExecutionPhase, LiveSession, ProviderKind } from "../state/types";
import type { SessionCardActions } from "../components/SessionCard";
import { renderSessionCard } from "../components/SessionCard";

export interface SessionsPanelActions extends SessionCardActions {
  setFilter(patch: Partial<CockpitState["filters"]>): void;
}

export function renderSessionsPanel(
  container: HTMLElement,
  state: Readonly<CockpitState>,
  expanded: Set<string>,
  actions: SessionsPanelActions
): void {
  const panel = container.createEl("section", {
    cls: "agent-cockpit-panel agent-cockpit-sessions-panel",
    attr: { "aria-labelledby": "agent-cockpit-live-heading" }
  });
  const heading = panel.createDiv({ cls: "agent-cockpit-panel-heading" });
  const title = heading.createDiv({ cls: "agent-cockpit-panel-title" });
  const titleLine = title.createDiv({ cls: "agent-cockpit-title-line" });
  titleLine.createEl("h2", { text: "Live cmux", attr: { id: "agent-cockpit-live-heading" } });
  titleLine.createSpan({
    cls: "agent-cockpit-count",
    text: String(state.sessions.length),
    attr: { "aria-label": `${state.sessions.length} cmux surfaces` }
  });
  title.createEl("p", { text: "Exact workspace, pane, and surface hierarchy with bounded evidence on demand." });
  const health = title.createDiv({ cls: "agent-cockpit-source-health", attr: { "aria-label": "Evidence source health" } });
  sourceHealthPill(health, "Topology", state.health.topology);
  sourceHealthPill(health, "Notifications", state.health.notifications);
  sourceHealthPill(health, "Lifecycle", state.health.lifecycle);

  renderFilters(panel, state, actions);
  const sessions = filteredSessions(state);
  if (sessions.length === 0) {
    const empty = panel.createDiv({ cls: "agent-cockpit-empty-state" });
    empty.createEl("h3", { text: state.sessions.length === 0 ? "No cmux surfaces discovered" : "No sessions match these filters" });
    empty.createEl("p", {
      text:
        state.sessions.length === 0
          ? "When cmux is reachable, its workspace, pane, and surface tree will appear here."
          : "Adjust the filters to return to the complete cmux tree."
    });
    return;
  }

  const taskById = new Map(state.tasks.map((task) => [task.taskId, task]));
  const grouped = groupSessions(sessions);
  const tree = panel.createDiv({ cls: "agent-cockpit-session-tree" });
  for (const workspace of grouped) {
    const workspaceGroup = tree.createEl("section", { cls: "agent-cockpit-workspace-group" });
    const workspaceHeading = workspaceGroup.createDiv({ cls: "agent-cockpit-workspace-heading" });
    workspaceHeading.createEl("h3", { text: workspace.title });
    workspaceHeading.createSpan({ text: workspace.directory ?? "CWD unavailable" });
    for (const pane of workspace.panes) {
      const paneGroup = workspaceGroup.createDiv({ cls: "agent-cockpit-pane-group" });
      paneGroup.createDiv({ cls: "agent-cockpit-pane-label", text: `Pane ${pane.index + 1}` });
      for (const session of pane.sessions) {
        renderSessionCard(paneGroup, {
          session,
          task: session.linkedTaskId ? taskById.get(session.linkedTaskId) ?? null : null,
          expanded: expanded.has(session.key),
          onExpandedChange: (isExpanded) => {
            if (isExpanded) expanded.add(session.key);
            else expanded.delete(session.key);
          },
          actions,
          variant: "session"
        });
      }
    }
  }
}

function sourceHealthPill(
  container: HTMLElement,
  label: string,
  health: CockpitState["health"]["topology"]
): void {
  const pill = container.createSpan({ cls: "agent-cockpit-source-health-pill" });
  pill.dataset.status = health.status;
  pill.createSpan({ cls: "agent-cockpit-state-dot", attr: { "aria-hidden": "true" } });
  pill.createSpan({ text: `${label}: ${health.status}` });
  pill.setAttribute("title", health.message);
}

function renderFilters(container: HTMLElement, state: Readonly<CockpitState>, actions: SessionsPanelActions): void {
  const filters = container.createDiv({ cls: "agent-cockpit-filters" });
  const repositories = unique(state.sessions.map((session) => session.currentDirectory).filter(isString));
  const workspaces = unique(state.sessions.map((session) => session.workspaceId));

  selectFilter(filters, "Repository", state.filters.repository, [{ value: "", label: "All repositories" }, ...repositories.map((value) => ({ value, label: lastPathPart(value) }))], (repository) => actions.setFilter({ repository }));
  selectFilter(
    filters,
    "Provider",
    state.filters.provider,
    [
      { value: "all", label: "All providers" },
      { value: "claude", label: "Claude" },
      { value: "codex", label: "Codex" },
      { value: "shell", label: "Shell" },
      { value: "unknown", label: "Unknown" }
    ],
    (provider) => actions.setFilter({ provider: provider as ProviderKind | "all" })
  );
  selectFilter(
    filters,
    "Execution",
    state.filters.phase,
    [
      { value: "all", label: "All execution phases" },
      { value: "unknown", label: "State unknown" },
      { value: "working", label: "Working" },
      { value: "waiting", label: "Needs input" },
      { value: "idle", label: "Idle" },
      { value: "turn-finished", label: "Review output" },
      { value: "failed", label: "Error reported" }
    ],
    (phase) => actions.setFilter({ phase: phase as ExecutionPhase | "all" })
  );
  selectFilter(filters, "Workspace", state.filters.workspaceId, [{ value: "", label: "All workspaces" }, ...workspaces.map((value) => ({ value, label: state.sessions.find((session) => session.workspaceId === value)?.workspaceTitle ?? value }))], (workspaceId) => actions.setFilter({ workspaceId }));
  selectFilter(
    filters,
    "Link",
    state.filters.link,
    [
      { value: "all", label: "Linked and orphan" },
      { value: "linked", label: "Linked only" },
      { value: "orphan", label: "Orphan only" }
    ],
    (link) => actions.setFilter({ link: link as CockpitState["filters"]["link"] })
  );

  const attention = filters.createEl("label", { cls: "agent-cockpit-checkbox-filter" });
  const checkbox = attention.createEl("input", { type: "checkbox" });
  checkbox.checked = state.filters.attentionOnly;
  checkbox.addEventListener("change", () => actions.setFilter({ attentionOnly: checkbox.checked }));
  attention.createSpan({ text: "Needs attention" });
}

function selectFilter(
  container: HTMLElement,
  label: string,
  value: string,
  options: readonly { value: string; label: string }[],
  onChange: (value: string) => void
): void {
  const wrapper = container.createEl("label", { cls: "agent-cockpit-filter" });
  wrapper.createSpan({ text: label });
  const select = wrapper.createEl("select", { attr: { "data-focus-key": `filter-${label.toLowerCase()}` } });
  for (const item of options) {
    const option = select.createEl("option", { value: item.value, text: item.label });
    option.selected = item.value === value;
  }
  select.addEventListener("change", () => onChange(select.value));
}

function filteredSessions(state: Readonly<CockpitState>): LiveSession[] {
  const attentionKeys = new Set(state.attention.map((item) => item.session?.key).filter(isString));
  return state.sessions.filter((session) => {
    if (state.filters.repository && session.currentDirectory !== state.filters.repository) return false;
    if (state.filters.provider !== "all" && session.provider.provider !== state.filters.provider) return false;
    if (state.filters.phase !== "all" && session.assessment.executionPhase !== state.filters.phase) return false;
    if (state.filters.workspaceId && session.workspaceId !== state.filters.workspaceId) return false;
    if (state.filters.link === "linked" && !session.linkedTaskId) return false;
    if (state.filters.link === "orphan" && session.linkedTaskId) return false;
    if (state.filters.attentionOnly && !attentionKeys.has(session.key)) return false;
    return true;
  });
}

interface WorkspaceGroup {
  id: string;
  title: string;
  directory: string | null;
  panes: { id: string; index: number; sessions: LiveSession[] }[];
}

function groupSessions(sessions: readonly LiveSession[]): WorkspaceGroup[] {
  const groups: WorkspaceGroup[] = [];
  for (const session of sessions) {
    let workspace = groups.find((candidate) => candidate.id === session.workspaceId);
    if (!workspace) {
      workspace = {
        id: session.workspaceId,
        title: session.workspaceTitle,
        directory: session.currentDirectory,
        panes: []
      };
      groups.push(workspace);
    }
    let pane = workspace.panes.find((candidate) => candidate.id === session.paneId);
    if (!pane) {
      pane = { id: session.paneId, index: session.paneIndex, sessions: [] };
      workspace.panes.push(pane);
    }
    pane.sessions.push(session);
  }
  return groups;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isString(value: string | null | undefined): value is string {
  return value != null;
}

function lastPathPart(value: string): string {
  return value.split("/").filter(Boolean).pop() ?? value;
}
