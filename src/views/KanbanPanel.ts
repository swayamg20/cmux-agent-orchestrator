import type { CockpitState } from "../state/types";
import { WORKFLOW_LABELS } from "../state/types";
import { renderTaskCard } from "../components/TaskCard";
import { WORKFLOW_STATUSES, type TaskRecord, type WorkflowStatus } from "../tasks/TaskSchema";

export interface KanbanPanelActions {
  createTask(): void;
  openTask(task: TaskRecord): void;
  moveTask(task: TaskRecord, status: WorkflowStatus): Promise<boolean>;
}

export function renderKanbanPanel(
  container: HTMLElement,
  state: Readonly<CockpitState>,
  actions: KanbanPanelActions
): void {
  const panel = container.createEl("section", {
    cls: "agent-cockpit-panel agent-cockpit-kanban-panel",
    attr: { "aria-labelledby": "agent-cockpit-board-heading" }
  });
  const heading = panel.createDiv({ cls: "agent-cockpit-panel-heading" });
  const title = heading.createDiv({ cls: "agent-cockpit-panel-title" });
  const titleLine = title.createDiv({ cls: "agent-cockpit-title-line" });
  titleLine.createEl("h2", { text: "Work board", attr: { id: "agent-cockpit-board-heading" } });
  titleLine.createSpan({
    cls: "agent-cockpit-count",
    text: String(state.tasks.length),
    attr: { "aria-label": `${state.tasks.length} durable tasks` }
  });
  title.createEl("p", {
    text: "Durable Markdown tasks. Moving a card changes workflow only—it never controls a live agent."
  });
  const create = heading.createEl("button", { text: "New task", attr: { type: "button" } });
  create.addEventListener("click", () => actions.createTask());

  if (state.tasks.length === 0) {
    panel.createDiv({
      cls: "agent-cockpit-board-empty-note",
      text: "No tracked work yet. With automatic tracking enabled, exact Claude and Codex sessions are added after startup or Refresh. Ambiguous runs remain under Agent runs."
    });
  }

  const board = panel.createDiv({ cls: "agent-cockpit-kanban-board" });
  for (const status of WORKFLOW_STATUSES) {
    const column = board.createDiv({ cls: "agent-cockpit-kanban-column" });
    column.dataset.status = status;
    const columnHeader = column.createDiv({ cls: "agent-cockpit-kanban-column-header" });
    columnHeader.createEl("h3", { text: WORKFLOW_LABELS[status] });
    const tasks = state.tasks.filter((task) => task.workflowStatus === status);
    columnHeader.createSpan({ cls: "agent-cockpit-count", text: String(tasks.length) });
    const taskList = column.createDiv({ cls: "agent-cockpit-kanban-task-list" });
    taskList.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    taskList.addEventListener("drop", (event) => {
      event.preventDefault();
      const taskId = event.dataTransfer?.getData("text/x-agent-cockpit-task");
      const task = state.tasks.find((candidate) => candidate.taskId === taskId);
      if (task) void actions.moveTask(task, status);
    });
    if (tasks.length === 0) {
      taskList.createDiv({
        cls: "agent-cockpit-kanban-column-empty",
        text: status === "backlog" ? "No queued work" : "No tasks"
      });
    }
    for (const task of tasks) {
      const sessions = state.sessions.filter((candidate) => candidate.linkedTaskId === task.taskId);
      renderTaskCard(taskList, task, sessions, {
        open: (selectedTask) => actions.openTask(selectedTask),
        move: (selectedTask, nextStatus) => actions.moveTask(selectedTask, nextStatus)
      });
    }
  }
}
