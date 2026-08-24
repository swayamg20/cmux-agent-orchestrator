import type { Confidence, ProviderKind } from "../state/types";

export type EvidenceAuthority = "structured" | "notification" | "heuristic" | "presence";
export type EvidenceSource =
  | "cmux-topology"
  | "cmux-notification"
  | "provider-detection"
  | "terminal-preview"
  | "provider-lifecycle"
  | "manual";

interface EvidenceBase {
  id: string;
  sessionKey: string;
  source: EvidenceSource;
  authority: EvidenceAuthority;
  confidence: Confidence;
  observedAt: number;
  occurredAt: number | null;
  summary: string;
}

export interface SurfacePresentEvidence extends EvidenceBase {
  kind: "surface-present";
}

export interface SurfaceMissingEvidence extends EvidenceBase {
  kind: "surface-missing";
}

export interface ProviderDetectedEvidence extends EvidenceBase {
  kind: "provider-detected";
  provider: ProviderKind;
  providerSessionId: string | null;
}

export type NotificationSignal = "input-requested" | "failure" | "turn-finished" | "generic";

export interface NotificationEvidence extends EvidenceBase {
  kind: "notification";
  notificationId: string;
  signal: NotificationSignal;
  unread: boolean;
}

export type ActivityKind =
  | "reasoning"
  | "planning"
  | "reading"
  | "editing"
  | "command"
  | "tool"
  | "background-work"
  | "unknown";

export interface ScreenObservedEvidence extends EvidenceBase {
  kind: "screen-observed";
  changed: boolean;
  activity: ActivityKind;
  fingerprint: string;
}

export type LifecycleSignal =
  | "session-started"
  | "turn-started"
  | "activity-started"
  | "activity-completed"
  | "input-requested"
  | "input-resolved"
  | "turn-completed"
  | "session-ended"
  | "runtime-failed";

export interface LifecycleEvidence extends EvidenceBase {
  kind: "lifecycle";
  signal: LifecycleSignal;
  activity: ActivityKind;
  provider: ProviderKind;
  providerSessionId: string | null;
}

export type SessionEvidence =
  | SurfacePresentEvidence
  | SurfaceMissingEvidence
  | ProviderDetectedEvidence
  | NotificationEvidence
  | ScreenObservedEvidence
  | LifecycleEvidence;
