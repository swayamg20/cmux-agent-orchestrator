import type { LiveSession } from "../state/types";
import type { TaskRecord, WorkflowStatus } from "../tasks/TaskSchema";

export const WORKFLOW_AUTOMATION_MODES = ["off", "suggest", "safe-auto"] as const;
export type WorkflowAutomationMode = (typeof WORKFLOW_AUTOMATION_MODES)[number];

export type WorkflowProposalReason =
  | "exact-run-attached"
  | "turn-finished"
  | "work-resumed";

export interface WorkflowProposal {
  id: string;
  taskId: string;
  sessionKey: string;
  from: WorkflowStatus;
  to: WorkflowStatus;
  reason: WorkflowProposalReason;
  explanation: string;
  confidence: LiveSession["assessment"]["confidence"];
  source: LiveSession["assessment"]["source"];
  evidenceId: string | null;
  observedAt: number;
  applyAutomatically: boolean;
}

export interface WorkflowAutomationInput {
  task: TaskRecord;
  session: LiveSession | null;
  exactBinding: boolean;
  mode: WorkflowAutomationMode;
  now: number;
}

const SUGGESTION_MAX_AGE_MS = 30 * 60_000;
const SAFE_AUTO_MAX_AGE_MS = 5 * 60_000;

export function evaluateWorkflowProposal(
  input: WorkflowAutomationInput
): WorkflowProposal | null {
  const { task, session, exactBinding, mode, now } = input;
  if (
    mode === "off" ||
    session === null ||
    !exactBinding ||
    session.linkedTaskId !== task.taskId ||
    task.workflowStatus === "parked" ||
    task.workflowStatus === "done"
  ) {
    return null;
  }

  if (task.workflowStatus === "backlog" && isExactLiveAgentRun(session)) {
    return proposal({
      task,
      session,
      to: "active",
      reason: "exact-run-attached",
      explanation: "An exact live Claude or Codex run is attached to this backlog task.",
      applyAutomatically: false
    });
  }

  const assessment = session.assessment;
  if (!isFresh(assessment.updatedAt, now, SUGGESTION_MAX_AGE_MS)) return null;

  if (
    task.workflowStatus === "active" &&
    assessment.executionPhase === "turn-finished" &&
    supportsReviewSuggestion(session)
  ) {
    const safeAutomaticEvidence =
      mode === "safe-auto" &&
      assessment.coverage === "structured" &&
      assessment.confidence === "high" &&
      assessment.primaryEvidenceId !== null &&
      isFresh(assessment.updatedAt, now, SAFE_AUTO_MAX_AGE_MS);
    return proposal({
      task,
      session,
      to: "review",
      reason: "turn-finished",
      explanation: safeAutomaticEvidence
        ? "The provider reported a completed turn with fresh, high-confidence structured evidence."
        : "The available provider evidence indicates that the latest turn finished and may be ready for review.",
      applyAutomatically: safeAutomaticEvidence
    });
  }

  if (
    task.workflowStatus === "review" &&
    assessment.executionPhase === "working" &&
    supportsWorkingSuggestion(session)
  ) {
    return proposal({
      task,
      session,
      to: "active",
      reason: "work-resumed",
      explanation: "The attached agent appears to be working again after this task entered Review.",
      applyAutomatically: false
    });
  }

  return null;
}

function proposal(input: {
  task: TaskRecord;
  session: LiveSession;
  to: WorkflowStatus;
  reason: WorkflowProposalReason;
  explanation: string;
  applyAutomatically: boolean;
}): WorkflowProposal {
  const { task, session } = input;
  const evidenceIdentity =
    session.assessment.primaryEvidenceId ?? session.provider.sessionId ?? session.key;
  return {
    id: [
      task.taskId,
      task.updatedAt,
      task.workflowStatus,
      input.to,
      input.reason,
      evidenceIdentity
    ].join(":"),
    taskId: task.taskId,
    sessionKey: session.key,
    from: task.workflowStatus,
    to: input.to,
    reason: input.reason,
    explanation: input.explanation,
    confidence: session.assessment.confidence,
    source: session.assessment.source,
    evidenceId: session.assessment.primaryEvidenceId,
    observedAt: session.assessment.updatedAt,
    applyAutomatically: input.applyAutomatically
  };
}

function isExactLiveAgentRun(session: LiveSession): boolean {
  return (
    session.assessment.surfacePresence === "present" &&
    (session.provider.provider === "claude" || session.provider.provider === "codex") &&
    session.provider.sessionId !== null &&
    session.provider.confidence === "high"
  );
}

function supportsReviewSuggestion(session: LiveSession): boolean {
  const assessment = session.assessment;
  return (
    assessment.primaryEvidenceId !== null &&
    (assessment.coverage === "structured" || assessment.coverage === "partial") &&
    assessment.confidence !== "low"
  );
}

function supportsWorkingSuggestion(session: LiveSession): boolean {
  const assessment = session.assessment;
  return (
    assessment.primaryEvidenceId !== null &&
    (assessment.coverage === "structured" || assessment.coverage === "partial") &&
    assessment.confidence !== "low"
  );
}

function isFresh(observedAt: number, now: number, maxAgeMs: number): boolean {
  return (
    Number.isFinite(observedAt) &&
    Number.isFinite(now) &&
    observedAt <= now &&
    now - observedAt <= maxAgeMs
  );
}
