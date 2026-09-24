import { renderTaskCard } from "../components/TaskCard";
import { taskHasLiveSession } from "./WorkBoardModel";
import type { WorkflowProposalActions } from "../components/WorkflowProposalNotice";
import type { CockpitState } from "../state/types";
import { WORKFLOW_LABELS } from "../state/types";
import { WORKFLOW_STATUSES, type TaskRecord, type WorkflowStatus } from "../tasks/TaskSchema";

export interface KanbanPanelActions extends WorkflowProposalActions {
  openTask(task: TaskRecord): void;
  moveTask(task: TaskRecord, status: WorkflowStatus): Promise<boolean>;
}

export interface KanbanSelectionActions {
  selectedTaskIds: ReadonlySet<string>;
  toggleTask(task: TaskRecord, selected: boolean): void;
}

export interface KanbanBoardOptions {
  tasks: readonly TaskRecord[];
  selection?: KanbanSelectionActions;
}

export function renderKanbanBoard(
  container: HTMLElement,
  state: Readonly<CockpitState>,
  actions: KanbanPanelActions,
  options: KanbanBoardOptions
): void {
  const visibleTaskIds = new Set(options.tasks.map((task) => task.taskId));
  const board = container.createDiv({
    cls: "agent-cockpit-kanban-board",
    attr: { "aria-label": "Workflow board" }
  });
  for (const status of WORKFLOW_STATUSES) {
    const column = board.createEl("section", {
      cls: "agent-cockpit-kanban-column",
      attr: { "aria-labelledby": `agent-cockpit-board-column-${status}` }
    });
    column.dataset.status = status;
    const columnHeader = column.createDiv({ cls: "agent-cockpit-kanban-column-header" });
    columnHeader.createSpan({ cls: "agent-cockpit-kanban-column-dot", attr: { "aria-hidden": "true" } });
    columnHeader.createEl("h3", {
      text: WORKFLOW_LABELS[status],
      attr: { id: `agent-cockpit-board-column-${status}` }
    });
    const tasks = sortLiveFirst(
      state.tasks.filter(
        (task) => task.workflowStatus === status && visibleTaskIds.has(task.taskId)
      ),
      state
    );
    columnHeader.createSpan({
      cls: "agent-cockpit-count",
      text: String(tasks.length),
      attr: { "aria-label": `${tasks.length} ${WORKFLOW_LABELS[status].toLocaleLowerCase()} tasks` }
    });
    const taskList = column.createDiv({
      cls: "agent-cockpit-kanban-task-list",
      attr: { role: "list", "aria-label": `${WORKFLOW_LABELS[status]} tasks` }
    });
    taskList.addEventListener("dragover", (event) => {
      if (options.selection !== undefined) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    taskList.addEventListener("drop", (event) => {
      if (options.selection !== undefined) return;
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
      const proposal = state.workflowProposals.find(
        (candidate) => candidate.taskId === task.taskId
      ) ?? null;
      const recentChange = state.recentWorkflowChanges.find(
        (candidate) => candidate.taskId === task.taskId
      ) ?? null;
      const card = taskList.createDiv({ attr: { role: "listitem" } });
      renderTaskCard(card, task, sessions, proposal, recentChange, {
        open: (selectedTask) => actions.openTask(selectedTask),
        move: (selectedTask, nextStatus) => actions.moveTask(selectedTask, nextStatus),
        apply: (candidate) => actions.apply(candidate),
        reviewInCmux: (candidate) => actions.reviewInCmux(candidate),
        dismiss: (candidate) => actions.dismiss(candidate)
      }, options.selection === undefined ? null : {
        selected: options.selection.selectedTaskIds.has(task.taskId),
        toggle: (selectedTask, selected) => options.selection?.toggleTask(selectedTask, selected)
      });
    }
  }
}

/** Live runs float to the top of each column; closed ones follow by recency. */
export function sortLiveFirst(
  tasks: readonly TaskRecord[],
  state: Pick<CockpitState, "sessions">
): TaskRecord[] {
  return tasks
    .map((task) => ({ task, live: taskHasLiveSession(task, state.sessions) }))
    .sort(
      (left, right) =>
        Number(right.live) - Number(left.live) ||
        right.task.updatedAt.localeCompare(left.task.updatedAt)
    )
    .map((entry) => entry.task);
}
