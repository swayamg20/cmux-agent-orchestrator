import type { CmuxAgentSource, CmuxAgentState, CmuxSnapshot, CmuxTarget } from "../../cmux/types";
import type { CmuxClient } from "../../cmux/CmuxClient";
import type { Confidence, ProviderKind } from "../../state/types";
import type { ProviderMatchSource, ProviderSessionKind, ProviderSessionReference } from "../types";

export interface AutomaticProviderSessionMapping extends ProviderSessionReference {
  matchSource: Exclude<ProviderMatchSource, "manual" | "task-binding">;
  confidence: Confidence;
  explanation: string;
  observedAt: number;
}

export interface AutomaticLifecycleObservation extends CmuxTarget {
  state: CmuxAgentState | "failed";
  source: CmuxAgentSource | "claude-registry";
  provider: ProviderKind;
  providerSessionId: string | null;
  observedAt: number;
  occurredAt: number | null;
  explanation: string;
}

export interface ProviderIdentityResolution {
  mappings: AutomaticProviderSessionMapping[];
  lifecycle: AutomaticLifecycleObservation[];
  checkedAt: number;
  nativeLifecycleAvailable: boolean;
  issues: string[];
}

export interface ProviderSessionResolver {
  resolve(
    snapshot: CmuxSnapshot,
    client: CmuxClient,
    signal?: AbortSignal
  ): Promise<ProviderIdentityResolution>;
  dispose(): void;
}

export const NOOP_PROVIDER_SESSION_RESOLVER: ProviderSessionResolver = {
  async resolve(snapshot): Promise<ProviderIdentityResolution> {
    return {
      mappings: [],
      lifecycle: [],
      checkedAt: snapshot.observedAt,
      nativeLifecycleAvailable: false,
      issues: []
    };
  },
  dispose(): void {
    // The no-op resolver owns no resources.
  }
};

export interface ProviderProcess {
  pid: number;
  parentPid: number;
  processGroupId: number;
  foregroundProcessGroupId: number;
  state: string;
  startedAt: string;
  executable: string;
  provider: ProviderSessionKind;
}

export interface ClaudeProcessSession {
  sessionId: string;
  cwd: string;
  status: string | null;
}

export interface LocalProcessIdentitySource {
  listForegroundProviderProcesses(signal?: AbortSignal): Promise<ProviderProcess[]>;
  readSurfaceId(pid: number, signal?: AbortSignal): Promise<string | null>;
  readClaudeSession(
    process: ProviderProcess,
    cwd: string,
    signal?: AbortSignal
  ): Promise<ClaudeProcessSession | null>;
  readCodexWriterSessionIds(pid: number, signal?: AbortSignal): Promise<string[]>;
  dispose(): void;
}
