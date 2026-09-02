export type ProviderSessionKind = "claude" | "codex";
export type ProviderTitleSource =
  | "explicit-name"
  | "ai-title"
  | "provider-preview"
  | "session-name"
  | "session-id";
export type ProviderMatchSource =
  | "manual"
  | "task-binding"
  | "cmux-agent-registry"
  | "claude-process-registry"
  | "codex-writer-lock";

export interface ProviderSessionMetadata {
  provider: ProviderSessionKind;
  sessionId: string;
  title: string;
  titleSource: ProviderTitleSource;
  cwd: string;
  updatedAt: number | null;
  status: string | null;
  parentSessionId?: string | null;
  sourceKind?: string | null;
}

export interface ProviderSessionReference {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
  provider: ProviderSessionKind;
  providerSessionId: string;
  matchedAt?: string;
}

export interface SessionConversation extends ProviderSessionMetadata {
  matchSource: ProviderMatchSource;
  matchConfidence: "low" | "medium" | "high";
}

export interface ProviderSessionSource {
  readonly provider: ProviderSessionKind;
  list(cwd: string, signal?: AbortSignal): Promise<ProviderSessionMetadata[]>;
  get(sessionId: string, cwd: string, signal?: AbortSignal): Promise<ProviderSessionMetadata | null>;
  dispose(): void;
}

export class ProviderMetadataError extends Error {
  constructor(message: string, public readonly originalError?: unknown) {
    super(message);
    this.name = "ProviderMetadataError";
  }
}
