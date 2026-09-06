import type { AppliedWorkflowChange } from "../state/types";
import { WORKFLOW_LABELS } from "../state/types";
import type { WorkflowProposal } from "../workflow/WorkflowAutomationPolicy";

export interface WorkflowProposalActions {
  apply(proposal: WorkflowProposal): Promise<boolean>;
  dismiss(proposal: WorkflowProposal): Promise<boolean>;
}

export function renderWorkflowProposalNotice(
  container: HTMLElement,
  proposal: WorkflowProposal,
  actions: WorkflowProposalActions,
  variant: "task" | "attention"
): HTMLElement {
  const notice = container.createDiv({
    cls: `agent-cockpit-workflow-suggestion agent-cockpit-workflow-suggestion--${variant}`
  });
  const copy = notice.createDiv({ cls: "agent-cockpit-workflow-suggestion-copy" });
  copy.createDiv({
    cls: "agent-cockpit-workflow-suggestion-title",
    text: proposal.applyAutomatically
      ? `Safe auto eligible: ${WORKFLOW_LABELS[proposal.to]}`
      : `Suggested: ${WORKFLOW_LABELS[proposal.to]}`
  });
  copy.createDiv({
    cls: "agent-cockpit-workflow-suggestion-detail",
    text: proposal.explanation
  });

  const controls = notice.createDiv({ cls: "agent-cockpit-workflow-suggestion-actions" });
  const apply = controls.createEl("button", {
    cls: "mod-cta",
    text: "Apply",
    attr: {
      type: "button",
      "aria-label": `Apply workflow suggestion and move to ${WORKFLOW_LABELS[proposal.to]}`
    }
  });
  const dismiss = controls.createEl("button", {
    text: "Dismiss",
    attr: { type: "button", "aria-label": "Dismiss workflow suggestion" }
  });
  let pending = false;
  const run = (operation: () => Promise<boolean>): void => {
    if (pending) return;
    pending = true;
    apply.disabled = true;
    dismiss.disabled = true;
    void operation()
      .catch(() => false)
      .finally(() => {
        pending = false;
        apply.disabled = false;
        dismiss.disabled = false;
      });
  };
  apply.addEventListener("click", () => run(() => actions.apply(proposal)));
  dismiss.addEventListener("click", () => run(() => actions.dismiss(proposal)));
  return notice;
}

export function renderAppliedWorkflowChange(
  container: HTMLElement,
  change: AppliedWorkflowChange
): HTMLElement {
  const notice = container.createDiv({
    cls: "agent-cockpit-workflow-applied",
    attr: { role: "status", title: change.explanation }
  });
  notice.createSpan({ cls: "agent-cockpit-workflow-applied-label", text: "Safe auto" });
  notice.createSpan({ text: `Moved automatically to ${WORKFLOW_LABELS[change.to]}` });
  return notice;
}
