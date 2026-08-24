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
  relation: RunRelation;
  parentRunId: string | null;
  firstAttachedAt: string;
  lastAttachedAt: string;
}

export type NewBindingRecord = Omit<BindingRecord, "bindingId" | "runId">;

export interface AttachBindingResult {
  binding: BindingRecord;
  run: AgentRunRecord;
  isNewRun: boolean;
}

export interface MachineBindings {
  bindings: BindingRecord[];
  runs: AgentRunRecord[];
}
