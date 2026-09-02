import { createHash } from "node:crypto";
import type { AgentDetector } from "../agents/AgentDetector";
import {
  surfaceKey,
  type CmuxNotification,
  type CmuxPreview,
  type CmuxSnapshot
} from "../cmux/types";
import type { ProviderDetection } from "../state/types";
import type { AutomaticLifecycleObservation } from "../providers/identity/types";
import { EvidenceLedger } from "./EvidenceLedger";
import type {
  ActivityKind,
  NotificationSignal,
  ProviderDetectedEvidence,
  LifecycleEvidence,
  ScreenObservedEvidence,
  SessionEvidence
} from "./types";

export class CmuxEvidenceService {
  private readonly ledger = new EvidenceLedger();
  private readonly screenFingerprints = new Map<string, string>();

  constructor(private readonly detector: AgentDetector) {}

  sync(
    snapshot: CmuxSnapshot,
    notifications: readonly CmuxNotification[],
    notificationObservedAt: number
  ): ReadonlySet<string> {
    const liveKeys = new Set<string>();
    for (const window of snapshot.windows) {
      for (const workspace of window.workspaces) {
        for (const pane of workspace.panes) {
          for (const surface of pane.surfaces) {
            const key = surfaceKey({ workspaceId: workspace.id, surfaceId: surface.id });
            liveKeys.add(key);
            this.ledger.replaceSource(key, "cmux-topology", [{
              id: `surface-present:${key}`,
              kind: "surface-present",
              sessionKey: key,
              source: "cmux-topology",
              authority: "presence",
              confidence: "high",
              observedAt: snapshot.observedAt,
              occurredAt: snapshot.observedAt,
              summary: "The canonical cmux surface is present in the current topology."
            }]);
            const titleDetection = this.detector.detect(surface, null);
            if (titleDetection.provider !== "unknown") {
              this.ledger.replaceSource(
                key,
                "provider-detection",
                [providerEvidenceRecord(key, titleDetection, snapshot.observedAt)]
              );
            }
          }
        }
      }
    }

    const notificationsByKey = new Map<string, CmuxNotification[]>();
    for (const notification of notifications) {
      const key = surfaceKey(notification);
      if (!liveKeys.has(key)) continue;
      const list = notificationsByKey.get(key) ?? [];
      list.push(notification);
      notificationsByKey.set(key, list);
    }
    for (const key of liveKeys) {
      const items = (notificationsByKey.get(key) ?? []).map((notification) =>
        notificationEvidence(key, notification, notificationObservedAt)
      );
      this.ledger.replaceSource(key, "cmux-notification", items);
    }

    this.ledger.retain(liveKeys);
    retainMap(this.screenFingerprints, liveKeys);
    return liveKeys;
  }

  recordProvider(key: string, detection: ProviderDetection, observedAt: number): void {
    this.ledger.replaceSource(key, "provider-detection", [providerEvidenceRecord(key, detection, observedAt)]);
  }

  recordLifecycle(
    liveKeys: ReadonlySet<string>,
    observations: readonly AutomaticLifecycleObservation[]
  ): void {
    const byKey = new Map<string, LifecycleEvidence[]>();
    for (const observation of observations) {
      const key = surfaceKey(observation);
      if (!liveKeys.has(key)) continue;
      const evidence = lifecycleEvidenceRecord(key, observation);
      const list = byKey.get(key) ?? [];
      list.push(evidence);
      byKey.set(key, list);
    }
    for (const key of liveKeys) {
      this.ledger.replaceSource(key, "provider-lifecycle", byKey.get(key) ?? []);
    }
  }

  recordPreview(sessionKey: string, preview: CmuxPreview): void {
    const fingerprint = createHash("sha256").update(preview.text).digest("hex");
    const previous = this.screenFingerprints.get(sessionKey);
    this.screenFingerprints.set(sessionKey, fingerprint);
    const changed = previous !== undefined && previous !== fingerprint;
    const evidence: ScreenObservedEvidence = {
      id: `screen:${sessionKey}:${preview.observedAt}:${fingerprint.slice(0, 12)}`,
      kind: "screen-observed",
      sessionKey,
      source: "terminal-preview",
      authority: "heuristic",
      confidence: "low",
      observedAt: preview.observedAt,
      occurredAt: preview.observedAt,
      summary: changed
        ? "The bounded terminal preview changed since its previous on-demand observation."
        : "A bounded terminal preview was observed on demand.",
      changed,
      activity: detectActivity(preview.text),
      fingerprint
    };
    this.ledger.append(evidence);
  }

  list(sessionKey: string): readonly SessionEvidence[] {
    return this.ledger.list(sessionKey);
  }

  clear(): void {
    this.ledger.clear();
    this.screenFingerprints.clear();
  }
}

function lifecycleEvidenceRecord(
  key: string,
  observation: AutomaticLifecycleObservation
): LifecycleEvidence {
  return {
    id: `lifecycle:${key}:${observation.source}:${observation.observedAt}`,
    kind: "lifecycle",
    sessionKey: key,
    source: "provider-lifecycle",
    authority: "structured",
    confidence:
      observation.source === "hook" || observation.source === "socket" ? "high" : "medium",
    observedAt: observation.observedAt,
    occurredAt: observation.occurredAt,
    summary: observation.explanation.slice(0, 256),
    signal: lifecycleSignal(observation.state),
    activity: "unknown",
    provider: observation.provider,
    providerSessionId: observation.providerSessionId
  };
}

function lifecycleSignal(
  state: AutomaticLifecycleObservation["state"]
): LifecycleEvidence["signal"] {
  switch (state) {
    case "working":
      return "activity-started";
    case "blocked":
      return "input-requested";
    case "idle":
      return "session-idle";
    case "done":
      return "turn-completed";
    case "failed":
      return "runtime-failed";
    case "unknown":
      return "session-started";
  }
}

function providerEvidenceRecord(
  key: string,
  detection: ProviderDetection,
  observedAt: number
): ProviderDetectedEvidence {
  return {
    id: `provider:${key}:${detection.provider}`,
    kind: "provider-detected",
    sessionKey: key,
    source: "provider-detection",
    authority: "heuristic",
    confidence: detection.confidence,
    observedAt,
    occurredAt: null,
    summary: detection.explanation.slice(0, 256),
    provider: detection.provider,
    providerSessionId: detection.sessionId
  };
}

function notificationEvidence(
  sessionKey: string,
  notification: CmuxNotification,
  observedAt: number
): SessionEvidence {
  const text = `${notification.title}\n${notification.subtitle}\n${notification.body}`;
  const signal = notificationSignal(text);
  return {
    id: `notification:${notification.id}:${notification.isRead ? "read" : "unread"}`,
    kind: "notification",
    sessionKey,
    source: "cmux-notification",
    authority: "notification",
    confidence: signal === "generic" ? "high" : "medium",
    observedAt,
    occurredAt: null,
    summary:
      signal === "input-requested"
        ? "An unread cmux notification appears to request human input."
        : signal === "failure"
          ? "An unread cmux notification contains a failure marker."
          : signal === "turn-finished"
            ? "An unread cmux notification suggests output may be ready for review."
            : excerpt(notification.title || notification.body || "cmux notification"),
    notificationId: notification.id,
    signal,
    unread: !notification.isRead
  };
}

function notificationSignal(text: string): NotificationSignal {
  if (/\b(?:error|failed|failure|panic|traceback|exception|unhealthy)\b/i.test(text)) return "failure";
  if (/\b(?:approve|approval|permission|confirm|waiting for (?:input|you)|needs? input)\b|\[(?:y\/n|yes\/no)\]|continue\?/i.test(text)) {
    return "input-requested";
  }
  if (/\b(?:ready for review|review requested|completed|finished successfully|implementation complete)\b/i.test(text)) {
    return "turn-finished";
  }
  return "generic";
}

function detectActivity(text: string): ActivityKind {
  if (/\b(?:thinking|reasoning|analyzing)\b/i.test(text)) return "reasoning";
  if (/\b(?:plan|planning|updated plan)\b/i.test(text)) return "planning";
  if (/\b(?:read|reading|explored|searched|inspected)\b/i.test(text)) return "reading";
  if (/\b(?:edit|edited|editing|updated|added|patched)\b/i.test(text)) return "editing";
  if (/\b(?:ran|running|command|exec)\b/i.test(text)) return "command";
  if (/\b(?:tool|browser|web search)\b/i.test(text)) return "tool";
  if (/\b(?:background|subagent|worker)\b/i.test(text)) return "background-work";
  return "unknown";
}

function retainMap<T>(values: Map<string, T>, keys: ReadonlySet<string>): void {
  for (const key of values.keys()) if (!keys.has(key)) values.delete(key);
}

function excerpt(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}
