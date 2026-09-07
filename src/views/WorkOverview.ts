import { setIcon } from "obsidian";
import type { CockpitState } from "../state/types";
import { WORKFLOW_LABELS } from "../state/types";
import { WORKFLOW_STATUSES } from "../tasks/TaskSchema";
import { taskHasLiveSession } from "./WorkBoardModel";

export interface WorkOverviewActions {
  createTask(): void;
  openBoard(): void;
}

export function renderWorkOverview(
  container: HTMLElement,
  state: Readonly<CockpitState>,
  actions: WorkOverviewActions
): void {
  const panel = container.createEl("section", {
    cls: "agent-cockpit-panel agent-cockpit-work-overview",
    attr: { "aria-labelledby": "agent-cockpit-work-overview-heading" }
  });
  const heading = panel.createDiv({ cls: "agent-cockpit-panel-heading" });
  const title = heading.createDiv({ cls: "agent-cockpit-panel-title" });
  const titleLine = title.createDiv({ cls: "agent-cockpit-title-line" });
  titleLine.createEl("h2", {
    text: "Work board",
    attr: { id: "agent-cockpit-work-overview-heading" }
  });
  titleLine.createSpan({
    cls: "agent-cockpit-count",
    text: String(state.tasks.length),
    attr: { "aria-label": `${state.tasks.length} durable tasks` }
  });
  title.createEl("p", {
    text: "A quick workflow summary. Open the board for focused planning and task movement."
  });
  const openBoard = heading.createEl("button", {
    cls: "agent-cockpit-open-board",
    attr: { type: "button", "aria-label": "Open full work board" }
  });
  setIcon(openBoard, "columns-3");
  openBoard.createSpan({ text: "Open board" });
  openBoard.addEventListener("click", () => actions.openBoard());

  const summary = panel.createDiv({
    cls: "agent-cockpit-work-summary",
    attr: { "aria-label": "Task totals by workflow" }
  });
  for (const status of WORKFLOW_STATUSES) {
    const count = state.tasks.filter((task) => task.workflowStatus === status).length;
    const item = summary.createDiv({ cls: "agent-cockpit-work-summary-item" });
    item.dataset.status = status;
    item.createSpan({ cls: "agent-cockpit-work-summary-count", text: String(count) });
    item.createSpan({ cls: "agent-cockpit-work-summary-label", text: WORKFLOW_LABELS[status] });
  }

  if (state.tasks.length === 0) {
    const empty = panel.createDiv({ cls: "agent-cockpit-work-overview-empty" });
    empty.createSpan({ text: "No tracked tasks yet." });
    const create = empty.createEl("button", { text: "Create task", attr: { type: "button" } });
    create.addEventListener("click", () => actions.createTask());
    return;
  }

  const liveTasks = state.tasks.filter((task) => taskHasLiveSession(task, state.sessions)).length;
  panel.createDiv({
    cls: "agent-cockpit-work-overview-footnote",
    text: `${liveTasks} ${liveTasks === 1 ? "task has" : "tasks have"} a live cmux run; ${state.tasks.length - liveTasks} ${state.tasks.length - liveTasks === 1 ? "does" : "do"} not.`
  });
}
