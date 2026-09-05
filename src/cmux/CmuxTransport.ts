import type {
  CmuxAgentRecord,
  CmuxEventSignal,
  CmuxNotification,
  CmuxPreview,
  CmuxProbe,
  CmuxSnapshot,
  CmuxTarget
} from "./types";

export interface PreviewRequest {
  lines: number;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface CmuxEventObserver {
  onSignal(signal: CmuxEventSignal): void;
  onError(error: unknown): void;
}

export interface CmuxTransport {
  probe(signal?: AbortSignal): Promise<CmuxProbe>;
  snapshot(signal?: AbortSignal): Promise<CmuxSnapshot>;
  notifications(signal?: AbortSignal): Promise<CmuxNotification[]>;
  agents?(signal?: AbortSignal): Promise<CmuxAgentRecord[] | null>;
  subscribeEvents?(observer: CmuxEventObserver): (() => void) | null;
  readPreview(target: CmuxTarget, request: PreviewRequest): Promise<CmuxPreview>;
  focusedTarget(signal?: AbortSignal): Promise<CmuxTarget | null>;
  focus(target: CmuxTarget, signal?: AbortSignal): Promise<void>;
  dispose(): void;
}
