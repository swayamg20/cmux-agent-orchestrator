import type { BindingRecord, WorkflowProposalDismissal } from "../bindings/types";
import { canonicalUuidEquals, normalizeCanonicalUuid } from "../security/identifiers";
import type { LiveSession } from "../state/types";
import type { TaskRecord } from "../tasks/TaskSchema";
import { exactTrackableIdentity } from "../tracking/AutomaticTaskTracking";
import {
  evaluateWorkflowProposal,
  type WorkflowAutomationMode,
  type WorkflowProposal
} from "./WorkflowAutomationPolicy";

export interface WorkflowProposalInput {
  tasks: readonly TaskRecord[];
  sessions: readonly LiveSession[];
  bindings: readonly BindingRecord[];
  dismissals: readonly WorkflowProposalDismissal[];
  mode: WorkflowAutomationMode;
  now: number;
  health: WorkflowEvidenceHealth;
}

export interface WorkflowEvidenceHealth {
  connected: boolean;
  topologyFresh: boolean;
  lifecycleFresh: boolean;
  notificationsFresh: boolean;
}

const SAFE_AUTO_CONFLICT_MAX_AGE_MS = 5 * 60_000;

export function buildWorkflowProposals(input: WorkflowProposalInput): WorkflowProposal[] {
  if (input.mode === "off" || !input.health.connected || !input.health.topologyFresh) return [];
  const dismissed = new Set(input.dismissals.map((candidate) => candidate.proposalId));
  const proposals: WorkflowProposal[] = [];

  for (const task of input.tasks) {
    const candidates = input.sessions
      .filter((session) => session.linkedTaskId === task.taskId)
      .map((session) =>
        evaluateWorkflowProposal({
          task,
          session,
          exactBinding: hasExactBinding(task, session, input.bindings),
          mode: input.mode,
          now: input.now
        })
      )
      .filter((proposal): proposal is WorkflowProposal => proposal !== null)
      .filter((proposal) => evidenceSourceIsFresh(proposal, input.health))
      .filter((proposal) => !dismissed.has(proposal.id))
      .sort(compareProposals);
    const selected = candidates[0];
    if (selected !== undefined) {
      proposals.push(
        selected.applyAutomatically &&
          hasFreshExactWorkingSibling(task, selected, input.sessions, input.bindings, input.health, input.now)
          ? {
              ...selected,
              applyAutomatically: false,
              explanation: `${selected.explanation} Another exact run is still working, so this change needs review.`
            }
          : selected
      );
    }
  }

  return proposals.sort(
    (left, right) =>
      Number(right.applyAutomatically) - Number(left.applyAutomatically) ||
      right.observedAt - left.observedAt ||
      left.taskId.localeCompare(right.taskId)
  );
}

function hasFreshExactWorkingSibling(
  task: TaskRecord,
  proposal: WorkflowProposal,
  sessions: readonly LiveSession[],
  bindings: readonly BindingRecord[],
  health: WorkflowEvidenceHealth,
  now: number
): boolean {
  return sessions.some((session) => {
    const assessment = session.assessment;
    return (
      session.key !== proposal.sessionKey &&
      session.linkedTaskId === task.taskId &&
      hasExactBinding(task, session, bindings) &&
      assessment.surfacePresence === "present" &&
      assessment.executionPhase === "working" &&
      evidenceHealthIsFresh(assessment.source, health) &&
      timestampIsFresh(assessment.updatedAt, now, SAFE_AUTO_CONFLICT_MAX_AGE_MS)
    );
  });
}

function evidenceSourceIsFresh(
  proposal: WorkflowProposal,
  health: WorkflowEvidenceHealth
): boolean {
  if (proposal.reason === "exact-run-attached") return true;
  if (proposal.source === "provider-lifecycle") return health.lifecycleFresh;
  if (proposal.source === "cmux-notification") return health.notificationsFresh;
  return false;
}

function evidenceHealthIsFresh(
  source: LiveSession["assessment"]["source"],
  health: WorkflowEvidenceHealth
): boolean {
  if (source === "provider-lifecycle") return health.lifecycleFresh;
  if (source === "cmux-notification") return health.notificationsFresh;
  return source !== "none" && health.topologyFresh;
}

function timestampIsFresh(observedAt: number, now: number, maxAgeMs: number): boolean {
  return (
    Number.isFinite(observedAt) &&
    Number.isFinite(now) &&
    observedAt <= now &&
    now - observedAt <= maxAgeMs
  );
}

function hasExactBinding(
  task: TaskRecord,
  session: LiveSession,
  bindings: readonly BindingRecord[]
): boolean {
  const identity = exactTrackableIdentity(session);
  if (identity === null) return false;
  const binding = bindings.find(
    (candidate) =>
      canonicalUuidEquals(candidate.workspaceId, session.workspaceId) &&
      canonicalUuidEquals(candidate.paneId, session.paneId) &&
      canonicalUuidEquals(candidate.surfaceId, session.surfaceId)
  );
  const bindingSessionId = normalizeCanonicalUuid(binding?.providerSessionId ?? "");
  return (
    binding !== undefined &&
    canonicalUuidEquals(binding.taskId, task.taskId) &&
    binding.provider === identity.provider &&
    bindingSessionId === identity.sessionId
  );
}

function compareProposals(left: WorkflowProposal, right: WorkflowProposal): number {
  return (
    Number(right.applyAutomatically) - Number(left.applyAutomatically) ||
    proposalPriority(right) - proposalPriority(left) ||
    right.observedAt - left.observedAt ||
    left.sessionKey.localeCompare(right.sessionKey)
  );
}

function proposalPriority(proposal: WorkflowProposal): number {
  if (proposal.reason === "turn-finished") return 3;
  if (proposal.reason === "exact-run-attached") return 2;
  return 1;
}
