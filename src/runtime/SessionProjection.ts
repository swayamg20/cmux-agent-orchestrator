import type { AgentDetector } from "../agents/AgentDetector";
import type { BindingRecord } from "../bindings/types";
import { surfaceKey, type CmuxNotification, type CmuxPreview, type CmuxSnapshot } from "../cmux/types";
import { reduceSessionEvidence } from "../evidence/SessionStateReducer";
import type { SessionEvidence } from "../evidence/types";
import type { LiveSession, ProviderDetection } from "../state/types";

export interface SessionProjectionInput {
  snapshot: CmuxSnapshot;
  notifications: readonly CmuxNotification[];
  bindings: readonly BindingRecord[];
  detector: AgentDetector;
  providerEvidence: ReadonlyMap<string, ProviderDetection>;
  previewFor(key: string): CmuxPreview | null;
  evidenceFor(key: string): readonly SessionEvidence[];
}

export function projectLiveSessions(input: SessionProjectionInput): LiveSession[] {
  const notificationIndex = new Map<string, CmuxNotification[]>();
  for (const notification of input.notifications) {
    const key = surfaceKey(notification);
    const list = notificationIndex.get(key) ?? [];
    list.push(notification);
    notificationIndex.set(key, list);
  }
  const bindingIndex = new Map(
    input.bindings.map((binding) => [surfaceKey(binding), binding] as const)
  );

  const sessions: LiveSession[] = [];
  for (const window of input.snapshot.windows) {
    for (const workspace of window.workspaces) {
      for (const pane of workspace.panes) {
        for (const surface of pane.surfaces) {
          const key = surfaceKey({ workspaceId: workspace.id, surfaceId: surface.id });
          const preview = input.previewFor(key);
          const titleDetection = input.detector.detect(surface, null);
          const provider =
            titleDetection.provider === "unknown"
              ? input.providerEvidence.get(key) ?? titleDetection
              : titleDetection;
          sessions.push({
            key,
            workspaceId: workspace.id,
            paneId: pane.id,
            surfaceId: surface.id,
            workspaceTitle: workspace.title,
            workspaceIndex: workspace.index,
            paneIndex: pane.index,
            surfaceIndex: surface.indexInPane,
            surfaceTitle: surface.title,
            surfaceType: surface.type,
            currentDirectory: workspace.currentDirectory,
            provider,
            assessment: reduceSessionEvidence(input.evidenceFor(key), input.snapshot.observedAt),
            observedAt: input.snapshot.observedAt,
            notifications: notificationIndex.get(key) ?? [],
            linkedTaskId: bindingIndex.get(key)?.taskId ?? null,
            preview
          });
        }
      }
    }
  }
  return sessions.sort(
    (left, right) =>
      left.workspaceIndex - right.workspaceIndex ||
      left.paneIndex - right.paneIndex ||
      left.surfaceIndex - right.surfaceIndex
  );
}
