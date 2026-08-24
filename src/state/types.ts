import type { CmuxNotification, CmuxPreview, CmuxSnapshot, CmuxTarget } from "../cmux/types";
import type { BindingRecord } from "../bindings/types";
import type { TaskRecord, WorkflowStatus } from "../tasks/TaskSchema";

export type ProviderKind = "claude" | "codex" | "shell" | "unknown";
export type Confidence = "low" | "medium" | "high";
export type RuntimeStateKind = "unknown" | "running" | "needs-input" | "idle" | "exited" | "error";

export interface RuntimeEvidence {
  source: "cmux-notification" | "surface-presence" | "screen-change" | "screen-heuristic" | "manual";
  confidence: Confidence;
  observedAt: number;
  explanation: string;
}

export interface ProviderDetection {
  provider: ProviderKind;
  confidence: Confidence;
  source: "surface-title" | "screen-preview" | "surface-type" | "none";
  explanation: string;
  sessionId: string | null;
}

export interface RuntimeAssessment {
  state: RuntimeStateKind;
  evidence: RuntimeEvidence;
  lastObservedChangeAt: number | null;
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
  runtime: RuntimeAssessment;
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
  runtime: RuntimeStateKind | "all";
  workspaceId: string;
  link: "all" | "linked" | "orphan";
  attentionOnly: boolean;
}

export interface CockpitState {
  connection: ConnectionState;
  snapshot: CmuxSnapshot | null;
  sessions: LiveSession[];
  notifications: CmuxNotification[];
  tasks: TaskRecord[];
  bindings: BindingRecord[];
  attention: AttentionItem[];
  filters: SessionFilters;
  refreshing: boolean;
  lastRefreshAt: number | null;
  error: string | null;
}

export const EMPTY_FILTERS: SessionFilters = {
  repository: "",
  provider: "all",
  runtime: "all",
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
  attention: [],
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
