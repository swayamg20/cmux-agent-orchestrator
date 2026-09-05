export interface BindingRecord {
  bindingId: string;
  runId: string;
  taskId: string;
  workspaceId: string;
  paneId: string;
  surfaceId: string;
  provider: "claude" | "codex" | "shell" | "unknown";
  providerSessionId: string | null;
  attachedAt: string;
}

export type RunRelation = "initial" | "resume" | "fork" | "handoff" | "unknown";

export interface AgentRunRecord {
  runId: string;
  taskId: string;
  provider: "claude" | "codex" | "shell" | "unknown";
  providerSessionId: string | null;
  taskRunCountTarget?: number;
  relation: RunRelation;
  parentRunId: string | null;
  firstAttachedAt: string;
  lastAttachedAt: string;
}

export interface ProviderSessionMapping {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
  provider: "claude" | "codex";
  providerSessionId: string;
  matchedAt: string;
}

export interface WorkflowProposalDismissal {
  proposalId: string;
  taskId: string;
  dismissedAt: string;
}

export type NewBindingRecord = Omit<BindingRecord, "bindingId" | "runId"> & {
  taskRunCountBaseline?: number;
};

export interface AttachBindingResult {
  binding: BindingRecord;
  run: AgentRunRecord;
  isNewRun: boolean;
}

export interface RelocateBindingInput {
  bindingId: string;
  runId: string;
  taskId: string;
  provider: "claude" | "codex";
  providerSessionId: string;
  fromWorkspaceId: string;
  fromPaneId: string;
  fromSurfaceId: string;
  toWorkspaceId: string;
  toPaneId: string;
  toSurfaceId: string;
  relocatedAt: string;
}

export interface MachineBindings {
  bindings: BindingRecord[];
  runs: AgentRunRecord[];
  providerSessions: ProviderSessionMapping[];
  workflowDismissals: WorkflowProposalDismissal[];
}
