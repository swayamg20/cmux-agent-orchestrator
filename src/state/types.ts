import type { CmuxNotification, CmuxPreview, CmuxSnapshot, CmuxTarget } from "../cmux/types";
import type { AgentRunRecord, BindingRecord } from "../bindings/types";
import type { ActivityKind, EvidenceSource } from "../evidence/types";
import type { TaskRecord, WorkflowStatus } from "../tasks/TaskSchema";

export type ProviderKind = "claude" | "codex" | "shell" | "unknown";
export type Confidence = "low" | "medium" | "high";
export type SurfacePresence = "present" | "missing";
export type AgentPresence = "unknown" | "attached" | "ended";
export type ExecutionPhase = "unknown" | "working" | "waiting" | "turn-finished" | "failed";
export type EvidenceCoverage = "structured" | "partial" | "fallback" | "none";

export interface ProviderDetection {
  provider: ProviderKind;
  confidence: Confidence;
  source: "surface-title" | "screen-preview" | "surface-type" | "none";
  explanation: string;
  sessionId: string | null;
}

export interface SessionAssessment {
  surfacePresence: SurfacePresence;
  agentPresence: AgentPresence;
  executionPhase: ExecutionPhase;
  activity: ActivityKind;
  coverage: EvidenceCoverage;
  confidence: Confidence;
  source: EvidenceSource | "none";
  explanation: string;
  updatedAt: number;
  lastActivityAt: number | null;
  primaryEvidenceId: string | null;
}

export interface LiveSession extends CmuxTarget {
  key: string;
  workspaceTitle: string;
  workspaceIndex: number;
  paneIndex: number;
  surfaceIndex: number;
  surfaceTitle: string;
  surfaceType: string;
  currentDirectory: string | null;
  provider: ProviderDetection;
  assessment: SessionAssessment;
  observedAt: number;
  notifications: CmuxNotification[];
  linkedTaskId: string | null;
  preview: CmuxPreview | null;
}

export type ConnectionStatus = "idle" | "connecting" | "connected" | "access-blocked" | "disconnected" | "error";

export interface ConnectionState {
  status: ConnectionStatus;
  message: string;
  versionText: string | null;
  accessMode: string | null;
  binaryPath: string | null;
  checkedAt: number | null;
}

export type AttentionReasonKind =
  | "unread-notification"
  | "needs-input"
  | "runtime-error"
  | "review-ready"
  | "linked-surface-missing"
  | "stale";

export interface AttentionReason {
  kind: AttentionReasonKind;
  label: string;
  detail: string;
  severity: 1 | 2 | 3 | 4;
  confidence: Confidence;
  firstObservedAt: number;
}

export interface AttentionItem {
  key: string;
  session: LiveSession | null;
  task: TaskRecord | null;
  reasons: AttentionReason[];
  severity: number;
}

export interface SessionFilters {
  repository: string;
  provider: ProviderKind | "all";
  phase: ExecutionPhase | "all";
  workspaceId: string;
  link: "all" | "linked" | "orphan";
  attentionOnly: boolean;
}

export type SourceHealthStatus = "fresh" | "stale" | "unavailable";

export interface SourceHealth {
  status: SourceHealthStatus;
  checkedAt: number | null;
  lastSuccessAt: number | null;
  message: string;
}

export interface CockpitHealth {
  topology: SourceHealth;
  notifications: SourceHealth;
  lifecycle: SourceHealth;
}

export interface CockpitState {
  connection: ConnectionState;
  snapshot: CmuxSnapshot | null;
  sessions: LiveSession[];
  notifications: CmuxNotification[];
  tasks: TaskRecord[];
  bindings: BindingRecord[];
  runs: AgentRunRecord[];
  attention: AttentionItem[];
  health: CockpitHealth;
  filters: SessionFilters;
  refreshing: boolean;
  lastRefreshAt: number | null;
  error: string | null;
}

export const EMPTY_FILTERS: SessionFilters = {
  repository: "",
  provider: "all",
  phase: "all",
  workspaceId: "",
  link: "all",
  attentionOnly: false
};

export const INITIAL_COCKPIT_STATE: CockpitState = {
  connection: {
    status: "idle",
    message: "Not connected",
    versionText: null,
    accessMode: null,
    binaryPath: null,
    checkedAt: null
  },
  snapshot: null,
  sessions: [],
  notifications: [],
  tasks: [],
  bindings: [],
  runs: [],
  attention: [],
  health: {
    topology: {
      status: "unavailable",
      checkedAt: null,
      lastSuccessAt: null,
      message: "Topology has not been loaded."
    },
    notifications: {
      status: "unavailable",
      checkedAt: null,
      lastSuccessAt: null,
      message: "Notifications have not been loaded."
    },
    lifecycle: {
      status: "unavailable",
      checkedAt: null,
      lastSuccessAt: null,
      message: "No structured provider lifecycle source is available."
    }
  },
  filters: EMPTY_FILTERS,
  refreshing: false,
  lastRefreshAt: null,
  error: null
};

export const WORKFLOW_LABELS: Record<WorkflowStatus, string> = {
  backlog: "Backlog",
  active: "Active",
  review: "Review",
  parked: "Parked",
  done: "Done"
};
