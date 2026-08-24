import type { AttentionItem, LiveSession } from "../state/types";

export const DEFAULT_SESSION_INBOX_LIMIT = 6;

export interface SessionInboxSource {
  sessions: readonly LiveSession[];
  attention: readonly AttentionItem[];
}

export interface SessionInboxSelection {
  sessions: LiveSession[];
  total: number;
}

/**
 * Returns detected, unlinked agent runs without creating durable work on the
 * user's behalf. Attention-bearing runs are kept at the front of the inbox.
 */
export function selectSessionInbox(
  source: SessionInboxSource,
  limit: number | null = DEFAULT_SESSION_INBOX_LIMIT
): SessionInboxSelection {
  const attentionSeverity = new Map<string, number>();
  for (const item of source.attention) {
    if (!item.session) continue;
    attentionSeverity.set(item.session.key, Math.max(item.severity, attentionSeverity.get(item.session.key) ?? 0));
  }

  const sessions = source.sessions
    .filter(
      (session) =>
        session.linkedTaskId === null &&
        (session.provider.provider === "claude" || session.provider.provider === "codex")
    )
    .sort((left, right) => {
      const priority = inboxPriority(right, attentionSeverity) - inboxPriority(left, attentionSeverity);
      if (priority !== 0) return priority;
      if (right.observedAt !== left.observedAt) return right.observedAt - left.observedAt;
      if (left.workspaceIndex !== right.workspaceIndex) return left.workspaceIndex - right.workspaceIndex;
      if (left.paneIndex !== right.paneIndex) return left.paneIndex - right.paneIndex;
      return left.surfaceIndex - right.surfaceIndex;
    });

  return {
    sessions: limit === null ? sessions : sessions.slice(0, Math.max(0, limit)),
    total: sessions.length
  };
}

function inboxPriority(session: LiveSession, attentionSeverity: ReadonlyMap<string, number>): number {
  const phasePriority: Record<LiveSession["assessment"]["executionPhase"], number> = {
    failed: 60,
    waiting: 50,
    "turn-finished": 40,
    working: 30,
    unknown: 10
  };
  const unread = session.notifications.some((notification) => !notification.isRead) ? 80 : 0;
  return (attentionSeverity.get(session.key) ?? 0) * 100 + unread + phasePriority[session.assessment.executionPhase];
}
