import type { AppliedWorkflowChange } from "../state/types";
import { WORKFLOW_LABELS } from "../state/types";
import type { WorkflowProposal } from "../workflow/WorkflowAutomationPolicy";

export interface WorkflowProposalActions {
  apply(proposal: WorkflowProposal): Promise<boolean>;
  reviewInCmux(proposal: WorkflowProposal): Promise<boolean>;
  dismiss(proposal: WorkflowProposal): Promise<boolean>;
}

export function renderWorkflowProposalNotice(
  container: HTMLElement,
  proposal: WorkflowProposal,
  actions: WorkflowProposalActions,
  variant: "task" | "attention"
): HTMLElement {
  const notice = container.createDiv({
    cls: `agent-cockpit-workflow-suggestion agent-cockpit-workflow-suggestion--${variant}`,
    attr: { role: "status", title: proposal.explanation }
  });
  const copy = notice.createDiv({ cls: "agent-cockpit-workflow-suggestion-copy" });
  copy.createDiv({
    cls: "agent-cockpit-workflow-suggestion-title",
    text: proposalTitle(proposal)
  });
  if (variant === "attention") {
    copy.createDiv({
      cls: "agent-cockpit-workflow-suggestion-detail",
      text: `${WORKFLOW_LABELS[proposal.from]} → ${WORKFLOW_LABELS[proposal.to]} · ${proposal.explanation}`
    });
  }

  const controls = notice.createDiv({ cls: "agent-cockpit-workflow-suggestion-actions" });
  const reviewsInCmux = proposal.from === "active" && proposal.to === "review";
  const apply = controls.createEl("button", {
    cls: "mod-cta agent-cockpit-action",
    text: reviewsInCmux ? "Review in cmux" : "Apply",
    attr: {
      type: "button",
      "aria-label": reviewsInCmux
        ? "Move the task to Review, focus its exact cmux surface, and bring cmux forward"
        : `Apply workflow suggestion and move to ${WORKFLOW_LABELS[proposal.to]}`
    }
  });
  const dismiss = controls.createEl("button", {
    cls: "agent-cockpit-action",
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
  apply.addEventListener("click", () => run(() =>
    reviewsInCmux ? actions.reviewInCmux(proposal) : actions.apply(proposal)
  ));
  dismiss.addEventListener("click", () => run(() => actions.dismiss(proposal)));
  return notice;
}

function proposalTitle(proposal: WorkflowProposal): string {
  if (proposal.applyAutomatically) return `Safe auto eligible: ${WORKFLOW_LABELS[proposal.to]}`;
  if (proposal.from === "active" && proposal.to === "review") return "Ready for review";
  if (proposal.from === "review" && proposal.to === "active") return "Agent resumed";
  return `Suggested: ${WORKFLOW_LABELS[proposal.to]}`;
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
