import type { LiveSession } from "../state/types";
import type { TaskRecord, WorkflowStatus } from "../tasks/TaskSchema";
import { WORKFLOW_STATUSES } from "../tasks/TaskSchema";
import { WORKFLOW_LABELS } from "../state/types";
import { formatRelativeTime, providerLabel, repositoryLabel } from "./SessionCard";
import { renderRuntimeBadge } from "./StatusBadge";

export interface TaskCardActions {
  open(task: TaskRecord): void;
  move(task: TaskRecord, status: WorkflowStatus): void;
}

export function renderTaskCard(
  container: HTMLElement,
  task: TaskRecord,
  sessions: readonly LiveSession[],
  actions: TaskCardActions
): HTMLElement {
  const card = container.createDiv({ cls: "agent-cockpit-task-card", attr: { draggable: "true" } });
  card.dataset.taskId = task.taskId;
  card.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData("text/x-agent-cockpit-task", task.taskId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });

  const top = card.createDiv({ cls: "agent-cockpit-task-card-top" });
  const priority = top.createSpan({ cls: "agent-cockpit-priority", text: task.priority });
  priority.dataset.priority = task.priority;
  top.createSpan({ cls: "agent-cockpit-run-count", text: `${task.runCount} ${task.runCount === 1 ? "run" : "runs"}` });

  const title = card.createEl("button", {
    cls: "agent-cockpit-task-title",
    text: task.title,
    attr: { type: "button" }
  });
  title.addEventListener("click", () => actions.open(task));

  const repository = card.createDiv({ cls: "agent-cockpit-task-repository", text: repositoryLabel(task.repository) });
  repository.setAttribute("title", task.repository ?? "Repository unknown");
  if (task.branch || task.worktree) {
    card.createDiv({ cls: "agent-cockpit-task-context", text: task.worktree ?? task.branch ?? "" });
  }

  const session = selectPrimarySession(sessions);
  if (session) {
    const runtime = card.createDiv({ cls: "agent-cockpit-task-runtime" });
    runtime.createSpan({ text: providerLabel(session.provider.provider) });
    renderRuntimeBadge(runtime, session.assessment);
    if (sessions.length > 1) {
      runtime.createSpan({
        cls: "agent-cockpit-run-count",
        text: `${sessions.length} live`,
        attr: { title: `${sessions.length} cmux surfaces are attached to this task.` }
      });
    }
    card.createDiv({
      cls: "agent-cockpit-task-context",
      text: `${session.workspaceTitle} · ${session.surfaceTitle}`
    });
    card.createDiv({
      cls: "agent-cockpit-task-context",
      text:
        session.assessment.lastActivityAt === null
          ? `Seen ${formatRelativeTime(session.observedAt)}`
          : `Activity ${formatRelativeTime(session.assessment.lastActivityAt)}`
    });
    const unread = session.notifications.find((notification) => !notification.isRead);
    if (unread) {
      card.createDiv({
        cls: "agent-cockpit-task-pending",
        text: excerpt(unread.title || unread.body || "Unread cmux notification")
      });
    } else if (session.assessment.executionPhase === "waiting") {
      card.createDiv({ cls: "agent-cockpit-task-pending", text: "Possible input request" });
    }
  } else {
    card.createDiv({ cls: "agent-cockpit-task-runtime agent-cockpit-muted", text: "No live session" });
  }

  const workflowLabel = card.createEl("label", { cls: "agent-cockpit-workflow-control" });
  workflowLabel.createSpan({ text: "Workflow" });
  const select = workflowLabel.createEl("select", { attr: { "aria-label": `Workflow state for ${task.title}` } });
  for (const status of WORKFLOW_STATUSES) {
    const option = select.createEl("option", { value: status, text: WORKFLOW_LABELS[status] });
    option.selected = task.workflowStatus === status;
  }
  select.addEventListener("change", () => {
    const status = select.value as WorkflowStatus;
    actions.move(task, status);
  });
  return card;
}

function selectPrimarySession(sessions: readonly LiveSession[]): LiveSession | null {
  const priority: Record<LiveSession["assessment"]["executionPhase"], number> = {
    failed: 5,
    waiting: 4,
    "turn-finished": 3,
    working: 2,
    unknown: 1
  };
  return [...sessions].sort(
    (left, right) =>
      priority[right.assessment.executionPhase] - priority[left.assessment.executionPhase] ||
      right.observedAt - left.observedAt
  )[0] ?? null;
}

function excerpt(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 100 ? `${normalized.slice(0, 97)}...` : normalized;
}
