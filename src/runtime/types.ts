import type { AgentDetector } from "../agents/AgentDetector";
import type { BindingRecord } from "../bindings/types";
import { surfaceKey, type CmuxNotification, type CmuxPreview, type CmuxSnapshot } from "../cmux/types";
import type { LiveSession } from "../state/types";
import type { RuntimeStateEngine } from "./RuntimeStateEngine";

export interface BuildSessionsInput {
  snapshot: CmuxSnapshot;
  notifications: readonly CmuxNotification[];
  bindings: readonly BindingRecord[];
  previews: ReadonlyMap<string, CmuxPreview>;
  detector: AgentDetector;
  runtimeEngine: RuntimeStateEngine;
  staleAfterMs: number;
}

export function buildLiveSessions(input: BuildSessionsInput): LiveSession[] {
  const sessions: LiveSession[] = [];
  const observedKeys = new Set<string>();
  for (const window of input.snapshot.windows) {
    for (const workspace of window.workspaces) {
      for (const pane of workspace.panes) {
        for (const surface of pane.surfaces) {
          const key = surfaceKey({ workspaceId: workspace.id, surfaceId: surface.id });
          observedKeys.add(key);
          const preview = input.previews.get(key) ?? null;
          const notifications = input.notifications.filter(
            (notification) => notification.workspaceId === workspace.id && notification.surfaceId === surface.id
          );
          const binding = input.bindings.find(
            (candidate) => candidate.workspaceId === workspace.id && candidate.surfaceId === surface.id
          );
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
            provider: input.detector.detect(surface, preview?.text ?? null),
            runtime: input.runtimeEngine.assess({
              key,
              notifications,
              preview,
              observedAt: input.snapshot.observedAt,
              staleAfterMs: input.staleAfterMs
            }),
            observedAt: input.snapshot.observedAt,
            notifications,
            linkedTaskId: binding?.taskId ?? null,
            preview
          });
        }
      }
    }
  }
  input.runtimeEngine.retain(observedKeys);
  return sessions.sort(
    (left, right) =>
      left.workspaceIndex - right.workspaceIndex ||
      left.paneIndex - right.paneIndex ||
      left.surfaceIndex - right.surfaceIndex
  );
}
