import type {
  ActivityKind,
  LifecycleEvidence,
  NotificationEvidence,
  ScreenObservedEvidence,
  SessionEvidence
} from "./types";
import type { Confidence, SessionAssessment } from "../state/types";

const AUTHORITY_RANK = {
  presence: 0,
  heuristic: 1,
  notification: 2,
  structured: 3
} as const;

export function reduceSessionEvidence(evidence: readonly SessionEvidence[], now: number): SessionAssessment {
  const ordered = [...evidence].sort(
    (left, right) =>
      AUTHORITY_RANK[right.authority] - AUTHORITY_RANK[left.authority] ||
      right.observedAt - left.observedAt
  );
  const lifecycle = ordered.find((item): item is LifecycleEvidence => item.kind === "lifecycle");
  const unreadNotification = ordered.find(
    (item): item is NotificationEvidence => item.kind === "notification" && item.unread
  );
  const changedScreen = [...evidence]
    .reverse()
    .find((item): item is ScreenObservedEvidence => item.kind === "screen-observed" && item.changed);
  const present = evidence.some((item) => item.kind === "surface-present");
  const missing = evidence.some((item) => item.kind === "surface-missing") && !present;

  const assessment: SessionAssessment = {
    surfacePresence: missing ? "missing" : "present",
    agentPresence: "unknown",
    executionPhase: "unknown",
    activity: changedScreen?.activity ?? "unknown",
    coverage: evidence.length === 0 ? "none" : "fallback",
    confidence: "low",
    source: present || missing ? "cmux-topology" : "none",
    explanation: present
      ? "The cmux surface exists, but no current structured lifecycle signal is available."
      : "No current cmux surface evidence is available.",
    updatedAt: now,
    lastActivityAt: changedScreen?.observedAt ?? null,
    primaryEvidenceId: null
  };

  if (lifecycle) applyLifecycle(assessment, lifecycle);
  else if (unreadNotification) applyNotification(assessment, unreadNotification);
  else if (changedScreen) applyScreenActivity(assessment, changedScreen);

  return assessment;
}

function applyLifecycle(assessment: SessionAssessment, evidence: LifecycleEvidence): void {
  assessment.coverage = "structured";
  assessment.confidence = evidence.confidence;
  assessment.source = evidence.source;
  assessment.explanation = evidence.summary;
  assessment.updatedAt = evidence.observedAt;
  assessment.primaryEvidenceId = evidence.id;
  assessment.activity = evidence.activity;
  assessment.agentPresence = evidence.signal === "session-ended" ? "ended" : "attached";
  if (evidence.signal === "runtime-failed") assessment.executionPhase = "failed";
  else if (evidence.signal === "input-requested") assessment.executionPhase = "waiting";
  else if (evidence.signal === "session-idle") assessment.executionPhase = "idle";
  else if (evidence.signal === "turn-completed") assessment.executionPhase = "turn-finished";
  else if (evidence.signal === "turn-started" || evidence.signal === "activity-started") {
    assessment.executionPhase = "working";
  }
  if (evidence.signal === "turn-started" || evidence.signal === "activity-started" || evidence.signal === "activity-completed") {
    assessment.lastActivityAt = evidence.occurredAt ?? evidence.observedAt;
  }
}

function applyNotification(assessment: SessionAssessment, evidence: NotificationEvidence): void {
  assessment.coverage = "partial";
  assessment.confidence = evidence.confidence;
  assessment.source = evidence.source;
  assessment.explanation = evidence.summary;
  assessment.updatedAt = evidence.observedAt;
  assessment.primaryEvidenceId = evidence.id;
  if (evidence.signal === "failure") assessment.executionPhase = "failed";
  else if (evidence.signal === "input-requested") assessment.executionPhase = "waiting";
  else if (evidence.signal === "turn-finished") assessment.executionPhase = "turn-finished";
}

function applyScreenActivity(assessment: SessionAssessment, evidence: ScreenObservedEvidence): void {
  assessment.coverage = "fallback";
  assessment.confidence = lowerConfidence(evidence.confidence);
  assessment.source = evidence.source;
  assessment.explanation =
    "The bounded terminal preview changed. This proves recent screen activity, not that the agent is still working.";
  assessment.updatedAt = evidence.observedAt;
  assessment.lastActivityAt = evidence.observedAt;
  assessment.primaryEvidenceId = evidence.id;
  assessment.activity = normalizeActivity(evidence.activity);
  assessment.executionPhase = "unknown";
}

function lowerConfidence(confidence: Confidence): Confidence {
  return confidence === "high" ? "medium" : "low";
}

function normalizeActivity(activity: ActivityKind): ActivityKind {
  return activity;
}
