import { setIcon } from "obsidian";
import type { LiveSession } from "../state/types";
import type { TaskRecord } from "../tasks/TaskSchema";
import { WORKFLOW_LABELS } from "../state/types";
import { phaseLabel } from "../components/StatusBadge";
import { formatRelativeTime, providerLabel, sessionDisplayTitle } from "../components/SessionCard";
import type { MissionControl, MissionControlStats } from "./MissionControlModel";
import { lastActivity } from "./MissionControlModel";

export interface WorkOverviewActions {
  createTask(): void;
  openBoard(): void;
  focus(session: LiveSession): void;
  openTask(task: TaskRecord): void;
  setShowArchived(showArchived: boolean): void;
}

export function renderMissionStats(container: HTMLElement, stats: MissionControlStats): void {
  const strip = container.createDiv({
    cls: "agent-cockpit-mission-stats",
    attr: { role: "list", "aria-label": "Work totals" }
  });
  const items: { key: keyof MissionControlStats; label: string }[] = [
    { key: "live", label: "Live" },
    { key: "review", label: "Review" },
    { key: "parked", label: "Parked" },
    { key: "archived", label: "Archived" }
  ];
  for (const { key, label } of items) {
    const item = strip.createDiv({ cls: "agent-cockpit-mission-stat", attr: { role: "listitem" } });
    item.dataset.stat = key;
    item.createSpan({ cls: "agent-cockpit-mission-stat-value", text: String(stats[key]) });
    item.createSpan({ cls: "agent-cockpit-mission-stat-label", text: label });
  }
}

export function renderWorkOverview(
  container: HTMLElement,
  mission: MissionControl,
  showArchived: boolean,
  totalTasks: number,
  actions: WorkOverviewActions
): void {
  const panel = container.createEl("section", {
    cls: "agent-cockpit-panel agent-cockpit-live-now",
    attr: { "aria-labelledby": "agent-cockpit-live-now-heading" }
  });
  const heading = panel.createDiv({ cls: "agent-cockpit-section-heading" });
  const titleLine = heading.createDiv({ cls: "agent-cockpit-title-line" });
  titleLine.createEl("h2", { text: "Live now", attr: { id: "agent-cockpit-live-now-heading" } });
  const liveRows = mission.liveGroups.reduce((sum, group) => sum + group.rows.length, 0);
  titleLine.createSpan({
    cls: "agent-cockpit-count",
    text: String(liveRows),
    attr: { "aria-label": `${liveRows} live agent runs` }
  });
  const openBoard = heading.createEl("button", {
    cls: "agent-cockpit-open-board",
    attr: { type: "button", "aria-label": "Open full work board" }
  });
  setIcon(openBoard, "columns-3");
  openBoard.createSpan({ text: "Open board" });
  openBoard.addEventListener("click", () => actions.openBoard());

  if (totalTasks === 0) {
    const empty = panel.createDiv({ cls: "agent-cockpit-work-overview-empty" });
    empty.createSpan({ text: "No tracked tasks yet." });
    const create = empty.createEl("button", { text: "Create task", attr: { type: "button" } });
    create.addEventListener("click", () => actions.createTask());
    return;
  }

  if (mission.liveGroups.length === 0) {
    panel.createDiv({
      cls: "agent-cockpit-live-empty",
      text: "No tracked agent is running right now."
    });
  }

  for (const group of mission.liveGroups) {
    const section = panel.createDiv({ cls: "agent-cockpit-live-group" });
    const groupHeading = section.createDiv({ cls: "agent-cockpit-live-group-heading" });
    groupHeading.createSpan({ text: group.repository });
    groupHeading.createSpan({ cls: "agent-cockpit-live-group-count", text: String(group.rows.length) });
    const list = section.createDiv({ cls: "agent-cockpit-live-list", attr: { role: "list" } });
    for (const { session, task } of group.rows) {
      renderLiveRow(list, session, task, actions);
    }
  }

  if (mission.archived.length === 0) return;
  const archive = panel.createDiv({ cls: "agent-cockpit-archive" });
  const toggle = archive.createEl("button", {
    cls: "agent-cockpit-archive-toggle",
    attr: { type: "button", "aria-expanded": String(showArchived) }
  });
  toggle.createSpan({
    text: `${showArchived ? "Hide" : "Show"} ${mission.archived.length} archived ${mission.archived.length === 1 ? "task" : "tasks"}`
  });
  const chevron = toggle.createSpan({ cls: "agent-cockpit-archive-chevron", attr: { "aria-hidden": "true" } });
  setIcon(chevron, showArchived ? "chevron-up" : "chevron-down");
  toggle.addEventListener("click", () => actions.setShowArchived(!showArchived));
  if (!showArchived) return;

  archive.createEl("p", {
    cls: "agent-cockpit-archive-note",
    text: "Their cmux sessions are closed. Resuming the same conversation reconnects it automatically."
  });
  const list = archive.createDiv({ cls: "agent-cockpit-live-list is-archived", attr: { role: "list" } });
  for (const task of mission.archived) {
    const row = list.createEl("button", {
      cls: "agent-cockpit-live-row",
      attr: { type: "button", role: "listitem", title: "Open task note" }
    });
    row.createSpan({ cls: "agent-cockpit-live-dot", attr: { "aria-hidden": "true" } });
    row.createSpan({ cls: "agent-cockpit-live-title", text: task.title });
    row.createSpan({ cls: "agent-cockpit-live-meta", text: task.repository ? repositoryTail(task.repository) : "" });
    row.createSpan({ cls: "agent-cockpit-live-phase", text: WORKFLOW_LABELS[task.workflowStatus] });
    row.addEventListener("click", () => actions.openTask(task));
  }
}

function renderLiveRow(
  list: HTMLElement,
  session: LiveSession,
  task: TaskRecord,
  actions: WorkOverviewActions
): void {
  const row = list.createDiv({ cls: "agent-cockpit-live-row", attr: { role: "listitem" } });
  row.dataset.state = session.assessment.executionPhase;
  const focus = row.createEl("button", {
    cls: "agent-cockpit-live-main",
    attr: { type: "button", title: "Focus in cmux" }
  });
  focus.createSpan({ cls: "agent-cockpit-live-dot", attr: { "aria-hidden": "true" } });
  focus.createSpan({ cls: "agent-cockpit-live-title", text: task.title || sessionDisplayTitle(session) });
  focus.createSpan({ cls: "agent-cockpit-live-meta", text: providerLabel(session.provider.provider) });
  focus.createSpan({ cls: "agent-cockpit-live-phase", text: phaseLabel(session.assessment.executionPhase) });
  focus.createSpan({
    cls: "agent-cockpit-live-time",
    text: formatRelativeTime(lastActivity(session))
  });
  focus.addEventListener("click", () => actions.focus(session));

  const open = row.createEl("button", {
    cls: "agent-cockpit-live-open clickable-icon",
    attr: { type: "button", "aria-label": `Open task note for ${task.title}`, title: "Open task note" }
  });
  setIcon(open, "file-text");
  open.addEventListener("click", () => actions.openTask(task));
}

function repositoryTail(repository: string): string {
  return repository.split("/").filter(Boolean).pop() ?? repository;
}
