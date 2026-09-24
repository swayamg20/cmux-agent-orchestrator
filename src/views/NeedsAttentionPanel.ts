import { setIcon } from "obsidian";
import type { AttentionItem, CockpitState } from "../state/types";
import type { SessionCardActions } from "../components/SessionCard";
import { renderSessionCard } from "../components/SessionCard";
import type { TaskRecord } from "../tasks/TaskSchema";
import {
  renderWorkflowProposalNotice,
  type WorkflowProposalActions
} from "../components/WorkflowProposalNotice";

export interface AttentionPanelActions extends SessionCardActions, WorkflowProposalActions {
  openTask(task: TaskRecord): void;
  clearClosedSessionLinks(): Promise<void>;
}

export interface AttentionPresentation {
  actionable: AttentionItem[];
  closedSurfaceLinks: AttentionItem[];
}

export function selectAttentionPresentation(
  attention: readonly AttentionItem[]
): AttentionPresentation {
  const actionable: AttentionItem[] = [];
  const closedSurfaceLinks: AttentionItem[] = [];
  for (const item of attention) {
    if (
      item.session === null &&
      item.task !== null &&
      item.reasons.length > 0 &&
      item.reasons.every((reason) => reason.kind === "linked-surface-missing")
    ) {
      closedSurfaceLinks.push(item);
    } else {
      actionable.push(item);
    }
  }
  return { actionable, closedSurfaceLinks };
}

export function renderNeedsAttentionPanel(
  container: HTMLElement,
  state: Readonly<CockpitState>,
  expanded: Set<string>,
  actions: AttentionPanelActions
): void {
  const presentation = selectAttentionPresentation(state.attention);
  const actionableCount = presentation.actionable.length;
  let attentionList: HTMLElement | null = null;
  const panel = container.createEl("section", {
    cls: `agent-cockpit-panel agent-cockpit-attention-panel${actionableCount === 0 ? " is-clear" : ""}`,
    attr:
      actionableCount === 0
        ? { "aria-label": "Attention status" }
        : { "aria-labelledby": "agent-cockpit-attention-heading" }
  });

  if (actionableCount === 0) {
    const empty = panel.createDiv({ cls: "agent-cockpit-inline-empty" });
    const icon = empty.createSpan({ attr: { "aria-hidden": "true" } });
    setIcon(icon, "circle-check-big");
    empty.createSpan({ cls: "agent-cockpit-inline-empty-title", text: "Nothing needs you" });
    empty.createSpan({
      text:
        state.connection.status === "connected"
          ? "No unread notifications or safely-derived runtime alerts."
          : "Live attention signals will return when cmux reconnects."
    });
  } else {
    const heading = panel.createDiv({ cls: "agent-cockpit-panel-heading" });
    const title = heading.createDiv({ cls: "agent-cockpit-panel-title" });
    const titleLine = title.createDiv({ cls: "agent-cockpit-title-line" });
    titleLine.createEl("h2", { text: "Needs you", attr: { id: "agent-cockpit-attention-heading" } });
    titleLine.createSpan({
      cls: "agent-cockpit-count",
      text: `${actionableCount}`,
      attr: { "aria-label": `${actionableCount} attention items` }
    });

    attentionList = panel.createDiv({ cls: "agent-cockpit-attention-list" });
    for (const item of presentation.actionable) {
      if (item.session) {
        const proposal = state.workflowProposals.find(
          (candidate) =>
            candidate.taskId === item.task?.taskId &&
            candidate.sessionKey === item.session?.key
        );
        if (proposal !== undefined) {
          renderWorkflowProposalNotice(attentionList, proposal, actions, "attention");
        }
        renderSessionCard(attentionList, {
          session: item.session,
          task: item.task,
          reasons: item.reasons,
          expanded: expanded.has(item.key),
          onExpandedChange: (isExpanded) => {
            if (isExpanded) expanded.add(item.key);
            else expanded.delete(item.key);
          },
          actions,
          variant: "attention"
        });
        continue;
      }
      const row = attentionList.createDiv({ cls: "agent-cockpit-task-attention-row" });
      const identity = row.createDiv();
      identity.createDiv({ cls: "agent-cockpit-session-title", text: item.reasons[0]?.label ?? "Task needs attention" });
      identity.createDiv({ cls: "agent-cockpit-session-meta", text: item.task?.title ?? "Linked task unavailable" });
      if (item.reasons[0]?.detail) row.createDiv({ cls: "agent-cockpit-attention-detail", text: item.reasons[0].detail });
      if (item.task) {
        const button = row.createEl("button", {
          cls: "agent-cockpit-action",
          text: "Open task",
          attr: { type: "button" }
        });
        button.addEventListener("click", () => actions.openTask(item.task!));
      }
    }
  }

  const closedCount = presentation.closedSurfaceLinks.length;
  if (closedCount > 0) {
    attentionList ??= panel.createDiv({ cls: "agent-cockpit-attention-list" });
    const row = attentionList.createDiv({ cls: "agent-cockpit-task-attention-row" });
    const identity = row.createDiv();
    identity.createDiv({ cls: "agent-cockpit-session-title", text: "Closed cmux sessions" });
    identity.createDiv({
      cls: "agent-cockpit-session-meta",
      text: `${closedCount} saved ${closedCount === 1 ? "link no longer points" : "links no longer point"} to a current cmux surface.`
    });
    row.createDiv({
      cls: "agent-cockpit-attention-detail",
      text: "Closed sessions are excluded from live views. Their tasks and run history are kept so exact conversations can reconnect."
    });
    const button = row.createEl("button", {
      cls: "agent-cockpit-action",
      text: closedCount === 1 ? "Clear saved link" : "Clear saved links",
      attr: {
        type: "button",
        title: "Remove closed cmux links while keeping tasks and run history"
      }
    });
    button.addEventListener("click", () => {
      void actions.clearClosedSessionLinks().catch(() => undefined);
    });
  }
}
