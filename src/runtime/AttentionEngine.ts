import type { BindingRecord } from "../bindings/types";
import { normalizeCanonicalUuid } from "../security/identifiers";
import type { AttentionItem, AttentionReason, LiveSession } from "../state/types";
import type { TaskRecord } from "../tasks/TaskSchema";

const REVIEW_PATTERN = /\b(?:ready for review|review requested|completed|finished successfully|implementation complete)\b/i;

export class AttentionEngine {
  private readonly firstObserved = new Map<string, number>();

  build(
    sessions: readonly LiveSession[],
    tasks: readonly TaskRecord[],
    bindings: readonly BindingRecord[],
    now: number,
    staleAfterMs: number
  ): AttentionItem[] {
    const items = new Map<string, AttentionItem>();
    const taskById = new Map(tasks.map((task) => [task.taskId, task]));
    const sessionByTarget = new Map(
      sessions.map((session) => [exactTargetKey(session), session] as const)
    );
    const firstSessionByTask = new Map<string, LiveSession>();
    for (const session of sessions) {
      if (session.linkedTaskId && !firstSessionByTask.has(session.linkedTaskId)) {
        firstSessionByTask.set(session.linkedTaskId, session);
      }
    }

    const add = (key: string, session: LiveSession | null, task: TaskRecord | null, reason: AttentionReason): void => {
      const item = items.get(key) ?? { key, session, task, reasons: [], severity: 0 };
      if (!item.reasons.some((candidate) => candidate.kind === reason.kind)) item.reasons.push(reason);
      item.severity = Math.max(item.severity, reason.severity);
      items.set(key, item);
    };

    for (const session of sessions) {
      const task = session.linkedTaskId ? taskById.get(session.linkedTaskId) ?? null : null;
      const firstSeen = this.seenAt(session.key, now);
      if (session.assessment.executionPhase === "failed") {
        add(session.key, session, task, {
          kind: "runtime-error",
          label: "Error reported",
          detail: session.assessment.explanation,
          severity: 4,
          confidence: session.assessment.confidence,
          firstObservedAt: firstSeen
        });
      } else if (session.assessment.executionPhase === "waiting") {
        add(session.key, session, task, {
          kind: "needs-input",
          label: "Input may be required",
          detail: session.assessment.explanation,
          severity: 4,
          confidence: session.assessment.confidence,
          firstObservedAt: firstSeen
        });
      }

      if (isStaleWorkingSession(session, now, staleAfterMs)) {
        add(session.key, session, task, {
          kind: "stale",
          label: "Working state may be stale",
          detail: `No activity has been observed for at least ${formatDuration(staleAfterMs)} while structured lifecycle evidence still reports Working. The task workflow was not changed.`,
          severity: 2,
          confidence: lowerConfidence(session.assessment.confidence),
          firstObservedAt: firstSeen
        });
      }

      const unread = session.notifications.filter((notification) => !notification.isRead);
      if (
        unread.length > 0 &&
        session.assessment.executionPhase !== "failed" &&
        session.assessment.executionPhase !== "waiting"
      ) {
        const review = unread.some((notification) =>
          REVIEW_PATTERN.test(`${notification.title}\n${notification.subtitle}\n${notification.body}`)
        );
        add(session.key, session, task, {
          kind: review ? "review-ready" : "unread-notification",
          label: review ? "Output may be ready for review" : "Unread cmux notification",
          detail: excerpt(unread[0]!.body || unread[0]!.title),
          severity: review ? 3 : 2,
          confidence: review ? "medium" : "high",
          firstObservedAt: firstSeen
        });
      }
    }

    for (const binding of bindings) {
      const bindingKey = exactTargetKey(binding);
      const session = sessionByTarget.get(bindingKey) ?? null;
      const boundTask = taskById.get(binding.taskId) ?? null;
      const key = session?.key ?? `missing:${bindingKey}`;
      if (boundTask === null) {
        add(key, session, null, {
          kind: "linked-task-missing",
          label: "Linked task note missing",
          detail: "The saved binding remains, but its Markdown task is unavailable. Attach or create a replacement task explicitly.",
          severity: 3,
          confidence: "high",
          firstObservedAt: this.seenAt(key, now)
        });
      }
      if (session !== null) continue;
      add(key, null, boundTask, {
        kind: "linked-surface-missing",
        label: "Linked surface disappeared",
        detail: "The cmux surface is absent. The task remains unchanged and provider exit is not proven.",
        severity: 3,
        confidence: "medium",
        firstObservedAt: this.seenAt(key, now)
      });
    }

    for (const task of tasks.filter((candidate) => candidate.workflowStatus === "review")) {
      const session = firstSessionByTask.get(task.taskId) ?? null;
      const key = session?.key ?? `task:${task.taskId}`;
      add(key, session, task, {
        kind: "review-ready",
        label: "Task is in Review",
        detail: "Workflow state indicates that human review is expected.",
        severity: 3,
        confidence: "high",
        firstObservedAt: this.seenAt(key, now)
      });
    }

    for (const key of this.firstObserved.keys()) {
      if (!items.has(key)) this.firstObserved.delete(key);
    }
    return [...items.values()].sort(
      (left, right) =>
        right.severity - left.severity ||
        Math.min(...left.reasons.map((reason) => reason.firstObservedAt)) -
          Math.min(...right.reasons.map((reason) => reason.firstObservedAt))
    );
  }

  clear(): void {
    this.firstObserved.clear();
  }

  private seenAt(key: string, now: number): number {
    const first = this.firstObserved.get(key) ?? now;
    this.firstObserved.set(key, first);
    return first;
  }
}

function exactTargetKey(target: {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
}): string {
  return [target.workspaceId, target.paneId, target.surfaceId]
    .map((id) => normalizeCanonicalUuid(id) ?? id)
    .join(":");
}

function excerpt(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 180 ? `${oneLine.slice(0, 177)}...` : oneLine;
}

function isStaleWorkingSession(session: LiveSession, now: number, staleAfterMs: number): boolean {
  const lastActivityAt = session.assessment.lastActivityAt;
  return (
    session.assessment.executionPhase === "working" &&
    session.assessment.coverage === "structured" &&
    lastActivityAt !== null &&
    Number.isFinite(staleAfterMs) &&
    staleAfterMs > 0 &&
    now >= lastActivityAt &&
    now - lastActivityAt >= staleAfterMs
  );
}

function lowerConfidence(confidence: LiveSession["assessment"]["confidence"]): LiveSession["assessment"]["confidence"] {
  return confidence === "high" ? "medium" : "low";
}

function formatDuration(durationMs: number): string {
  const minutes = Math.round(durationMs / 60_000);
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
