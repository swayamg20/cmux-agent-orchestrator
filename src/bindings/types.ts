export interface BindingRecord {
  taskId: string;
  workspaceId: string;
  paneId: string;
  surfaceId: string;
  provider: "claude" | "codex" | "shell" | "unknown";
  providerSessionId: string | null;
  attachedAt: string;
}

export interface MachineBindings {
  bindings: BindingRecord[];
}

