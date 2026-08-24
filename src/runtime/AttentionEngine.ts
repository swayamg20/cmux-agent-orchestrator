import type { BindingRecord } from "../bindings/types";
import type { AttentionItem, AttentionReason, LiveSession } from "../state/types";
import type { TaskRecord } from "../tasks/TaskSchema";

const REVIEW_PATTERN = /\b(?:ready for review|review requested|completed|finished successfully|implementation complete)\b/i;

export class AttentionEngine {
  private readonly firstObserved = new Map<string, number>();

  build(
    sessions: readonly LiveSession[],
    tasks: readonly TaskRecord[],
    bindings: readonly BindingRecord[],
    now: number
  ): AttentionItem[] {
    const items = new Map<string, AttentionItem>();
    const taskById = new Map(tasks.map((task) => [task.taskId, task]));
    const sessionByTarget = new Map(
      sessions.map((session) => [`${session.workspaceId}:${session.surfaceId}`, session] as const)
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
      const exists = sessionByTarget.has(`${binding.workspaceId}:${binding.surfaceId}`);
      if (exists) continue;
      const key = `missing:${binding.workspaceId}:${binding.surfaceId}`;
      add(key, null, taskById.get(binding.taskId) ?? null, {
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

function excerpt(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 180 ? `${oneLine.slice(0, 177)}...` : oneLine;
}
