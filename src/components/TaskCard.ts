import type { AppliedWorkflowChange, LiveSession } from "../state/types";
import type { TaskRecord, WorkflowStatus } from "../tasks/TaskSchema";
import { WORKFLOW_STATUSES } from "../tasks/TaskSchema";
import { WORKFLOW_LABELS } from "../state/types";
import { formatRelativeTime, providerLabel, repositoryLabel } from "./SessionCard";
import { renderRuntimeBadge } from "./StatusBadge";
import { describeLiveRun, lastActiveAt } from "../views/MissionControlModel";
import { displayTaskTitle } from "../tasks/TaskTitleCache";
import {
  renderAppliedWorkflowChange,
  renderWorkflowProposalNotice,
  type WorkflowProposalActions
} from "./WorkflowProposalNotice";
import type { WorkflowProposal } from "../workflow/WorkflowAutomationPolicy";

export interface TaskCardActions extends WorkflowProposalActions {
  open(task: TaskRecord): void;
  move(task: TaskRecord, status: WorkflowStatus): Promise<boolean>;
}

export interface TaskCardSelection {
  selected: boolean;
  toggle(task: TaskRecord, selected: boolean): void;
}

export function renderTaskCard(
  container: HTMLElement,
  task: TaskRecord,
  sessions: readonly LiveSession[],
  proposal: WorkflowProposal | null,
  recentChange: AppliedWorkflowChange | null,
  actions: TaskCardActions,
  selection: TaskCardSelection | null = null,
  titles: Readonly<Record<string, string>> = {}
): HTMLElement {
  const card = container.createDiv({
    cls: "agent-cockpit-task-card",
    attr: {
      draggable: selection === null ? "true" : "false",
      ...(selection === null ? {} : { "data-selected": String(selection.selected) })
    }
  });
  card.dataset.taskId = task.taskId;
  card.addEventListener("dragstart", (event) => {
    if (selection !== null) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData("text/x-agent-cockpit-task", task.taskId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });

  const session = selectPrimarySession(sessions);
  card.dataset.live = String(session !== null);
  if (session) card.dataset.state = session.assessment.executionPhase;

  const top = card.createDiv({ cls: "agent-cockpit-task-card-top" });
  const leading = top.createDiv({ cls: "agent-cockpit-task-card-leading" });
  if (selection !== null) {
    const selectionLabel = leading.createEl("label", {
      cls: "agent-cockpit-task-selection",
      attr: { title: `Select ${task.title}` }
    });
    const checkbox = selectionLabel.createEl("input", {
      attr: {
        type: "checkbox",
        "aria-label": `Select ${task.title}`,
        "data-focus-key": `board-select-${task.taskId}`
      }
    });
    checkbox.checked = selection.selected;
    checkbox.addEventListener("change", () => selection.toggle(task, checkbox.checked));
  }
  leading.createSpan({ cls: "agent-cockpit-task-dot", attr: { "aria-hidden": "true" } });
  const repository = leading.createSpan({
    cls: "agent-cockpit-task-repository",
    text: repositoryLabel(task.repository)
  });
  repository.setAttribute(
    "title",
    [task.repository ?? "Repository unknown", task.worktree ?? task.branch].filter(Boolean).join(" · ")
  );
  const activityAt = session ? lastActiveAt(session) : Date.parse(task.updatedAt);
  if (activityAt !== null && Number.isFinite(activityAt)) {
    top.createSpan({
      cls: "agent-cockpit-task-time",
      text: formatRelativeTime(activityAt),
      attr: { title: `Last active ${new Date(activityAt).toLocaleString()}` }
    });
  }

  const described = session
    ? describeLiveRun(task, session, repositoryLabel(task.repository ?? session.currentDirectory))
    : { title: displayTaskTitle(task, titles), detail: null };
  const title = card.createEl("button", {
    cls: "agent-cockpit-task-title",
    text: described.title,
    attr: { type: "button", title: described.title }
  });
  title.addEventListener("click", () => actions.open(task));

  if (session) {
    if (described.detail !== null) {
      card.createDiv({
        cls: "agent-cockpit-task-run-title",
        text: described.detail,
        attr: { title: described.detail }
      });
    }
    const unread = session.notifications.find((notification) => !notification.isRead);
    if (unread) {
      card.createDiv({
        cls: "agent-cockpit-task-pending",
        text: excerpt(unread.title || unread.body || "Unread cmux notification")
      });
    } else if (session.assessment.executionPhase === "waiting") {
      card.createDiv({ cls: "agent-cockpit-task-pending", text: "Possible input request" });
    }
  }

  if (proposal !== null) {
    renderWorkflowProposalNotice(card, proposal, actions, "task");
  } else if (recentChange !== null) {
    renderAppliedWorkflowChange(card, recentChange);
  }

  const footer = card.createDiv({ cls: "agent-cockpit-task-footer" });
  if (session) {
    const runtime = footer.createDiv({
      cls: "agent-cockpit-task-runtime",
      attr: { title: `${session.workspaceTitle} · ${session.surfaceTitle}` }
    });
    runtime.createSpan({ text: providerLabel(session.provider.provider) });
    if (session.assessment.executionPhase !== "unknown") renderRuntimeBadge(runtime, session.assessment);
    if (sessions.length > 1) {
      runtime.createSpan({
        cls: "agent-cockpit-run-count",
        text: `${sessions.length} live`,
        attr: { title: `${sessions.length} cmux surfaces are attached to this task.` }
      });
    }
  } else {
    footer.createDiv({ cls: "agent-cockpit-task-runtime agent-cockpit-muted", text: "Session closed" });
  }
  if (task.priority === "high" || task.priority === "urgent") {
    const priority = footer.createSpan({ cls: "agent-cockpit-priority", text: task.priority });
    priority.dataset.priority = task.priority;
  }

  const workflowLabel = footer.createEl("label", { cls: "agent-cockpit-workflow-control" });
  workflowLabel.createSpan({ cls: "agent-cockpit-visually-hidden", text: "Workflow" });
  const select = workflowLabel.createEl("select", { attr: { "aria-label": `Workflow state for ${task.title}` } });
  for (const status of WORKFLOW_STATUSES) {
    const option = select.createEl("option", { value: status, text: WORKFLOW_LABELS[status] });
    option.selected = task.workflowStatus === status;
  }
  select.addEventListener("change", () => {
    const status = select.value as WorkflowStatus;
    select.disabled = true;
    void actions
      .move(task, status)
      .catch(() => false)
      .then((moved) => {
        if (!moved) select.value = task.workflowStatus;
      })
      .finally(() => {
        select.disabled = false;
      });
  });
  return card;
}

function selectPrimarySession(sessions: readonly LiveSession[]): LiveSession | null {
  const priority: Record<LiveSession["assessment"]["executionPhase"], number> = {
    failed: 5,
    waiting: 4,
    "turn-finished": 3,
    working: 2,
    idle: 1,
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
