import { describe, expect, it } from "vitest";
import type { AttentionItem, LiveSession, ProviderKind, RuntimeStateKind } from "../../src/state/types";
import { selectSessionInbox } from "../../src/views/SessionInboxModel";

function session(
  key: string,
  provider: ProviderKind,
  runtime: RuntimeStateKind = "unknown",
  linkedTaskId: string | null = null
): LiveSession {
  return {
    key,
    workspaceId: `workspace-${key}`,
    paneId: `pane-${key}`,
    surfaceId: `surface-${key}`,
    workspaceTitle: `Workspace ${key}`,
    workspaceIndex: 0,
    paneIndex: 0,
    surfaceIndex: 0,
    surfaceTitle: `Surface ${key}`,
    surfaceType: "terminal",
    currentDirectory: `/repo/${key}`,
    provider: {
      provider,
      confidence: provider === "unknown" ? "low" : "medium",
      source: provider === "unknown" ? "none" : "screen-preview",
      explanation: "fixture",
      sessionId: null
    },
    runtime: {
      state: runtime,
      evidence: {
        source: "surface-presence",
        confidence: "low",
        observedAt: 1_000,
        explanation: "fixture"
      },
      lastObservedChangeAt: null
    },
    observedAt: 1_000,
    notifications: [],
    linkedTaskId,
    preview: null
  };
}

describe("selectSessionInbox", () => {
  it("automatically includes only unlinked Claude and Codex runs", () => {
    const result = selectSessionInbox(
      {
        sessions: [
          session("codex", "codex"),
          session("claude", "claude"),
          session("shell", "shell"),
          session("unknown", "unknown"),
          session("linked", "codex", "unknown", "task-id")
        ],
        attention: []
      },
      null
    );

    expect(result.total).toBe(2);
    expect(result.sessions.map((item) => item.key)).toEqual(["codex", "claude"]);
  });

  it("puts attention-bearing runs first without creating or linking anything", () => {
    const ordinary = session("ordinary", "codex", "running");
    const urgent = session("urgent", "claude", "needs-input");
    const attention: AttentionItem = {
      key: urgent.key,
      session: urgent,
      task: null,
      reasons: [],
      severity: 4
    };

    const result = selectSessionInbox({ sessions: [ordinary, urgent], attention: [attention] }, null);

    expect(result.sessions.map((item) => item.key)).toEqual(["urgent", "ordinary"]);
    expect(result.sessions.every((item) => item.linkedTaskId === null)).toBe(true);
  });

  it("reports the full count while bounding the initial visual list", () => {
    const sessions = Array.from({ length: 9 }, (_, index) => session(`run-${index}`, "codex"));
    const result = selectSessionInbox({ sessions, attention: [] }, 6);

    expect(result.total).toBe(9);
    expect(result.sessions).toHaveLength(6);
  });
});
