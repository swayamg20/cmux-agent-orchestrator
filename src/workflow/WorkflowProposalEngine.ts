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
}

export function buildWorkflowProposals(input: WorkflowProposalInput): WorkflowProposal[] {
  if (input.mode === "off") return [];
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
      .filter((proposal) => !dismissed.has(proposal.id))
      .sort(compareProposals);
    const selected = candidates[0];
    if (selected !== undefined) proposals.push(selected);
  }

  return proposals.sort(
    (left, right) =>
      Number(right.applyAutomatically) - Number(left.applyAutomatically) ||
      right.observedAt - left.observedAt ||
      left.taskId.localeCompare(right.taskId)
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
