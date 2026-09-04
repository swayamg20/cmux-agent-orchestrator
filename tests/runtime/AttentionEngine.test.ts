import { describe, expect, it } from "vitest";
import { AttentionEngine } from "../../src/runtime/AttentionEngine";
import type { BindingRecord } from "../../src/bindings/types";
import type { LiveSession } from "../../src/state/types";
import type { TaskRecord } from "../../src/tasks/TaskSchema";

const STALE_AFTER_MS = 30 * 60_000;

const task = (workflowStatus: TaskRecord["workflowStatus"] = "active"): TaskRecord => ({
  file: {} as TaskRecord["file"],
  taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "Durable task",
  workflowStatus,
  priority: "normal",
  repository: "/repo",
  branch: null,
  worktree: null,
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  runCount: 0
});

const binding: BindingRecord = {
  bindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  paneId: "33333333-3333-4333-8333-333333333333",
  surfaceId: "44444444-4444-4444-8444-444444444444",
  provider: "codex",
  providerSessionId: null,
  attachedAt: "2026-08-23T00:00:00.000Z"
};

describe("AttentionEngine", () => {
  it("reports a missing bound surface without completing the task", () => {
    const work = task("active");
    const result = new AttentionEngine().build([], [work], [binding], 1_000, STALE_AFTER_MS);
    expect(result[0]?.reasons[0]?.kind).toBe("linked-surface-missing");
    expect(work.workflowStatus).toBe("active");
  });

  it("includes durable review tasks even without a live session", () => {
    const result = new AttentionEngine().build([], [task("review")], [], 1_000, STALE_AFTER_MS);
    expect(result.some((item) => item.reasons.some((reason) => reason.kind === "review-ready"))).toBe(true);
  });

  it("reports a missing task note without discarding its live session binding", () => {
    const session: LiveSession = {
      key: `${binding.workspaceId}:${binding.surfaceId}`,
      workspaceId: binding.workspaceId,
      paneId: binding.paneId,
      surfaceId: binding.surfaceId,
      workspaceTitle: "Workspace",
      workspaceIndex: 0,
      paneIndex: 0,
      surfaceIndex: 0,
      surfaceTitle: "Surface",
      surfaceType: "terminal",
      currentDirectory: "/repo",
      provider: {
        provider: "codex",
        confidence: "high",
        source: "task-binding",
        explanation: "fixture",
        sessionId: null
      },
      assessment: assessment("unknown"),
      observedAt: 1_000,
      notifications: [],
      linkedTaskId: binding.taskId,
      conversation: null,
      preview: null
    };

    const result = new AttentionEngine().build([session], [], [binding], 1_000, STALE_AFTER_MS);

    expect(result).toMatchObject([
      {
        session: { surfaceId: binding.surfaceId, linkedTaskId: binding.taskId },
        task: null,
        reasons: [{ kind: "linked-task-missing", confidence: "high" }]
      }
    ]);
    expect(session.linkedTaskId).toBe(binding.taskId);
  });

  it("does not report a bound surface missing because UUID casing differs", () => {
    const workspaceId = "a2222222-a222-4222-8222-a22222222222";
    const paneId = "b3333333-b333-4333-8333-b33333333333";
    const surfaceId = "c4444444-c444-4444-8444-c44444444444";
    const session: LiveSession = {
      key: `${workspaceId}:${surfaceId}`,
      workspaceId,
      paneId,
      surfaceId,
      workspaceTitle: "Workspace",
      workspaceIndex: 0,
      paneIndex: 0,
      surfaceIndex: 0,
      surfaceTitle: "Surface",
      surfaceType: "terminal",
      currentDirectory: "/repo",
      provider: {
        provider: "codex",
        confidence: "medium",
        source: "screen-preview",
        explanation: "fixture",
        sessionId: null
      },
      assessment: assessment("unknown"),
      observedAt: 1_000,
      notifications: [],
      linkedTaskId: binding.taskId,
      conversation: null,
      preview: null
    };
    const uppercaseBinding = {
      ...binding,
      workspaceId: workspaceId.toUpperCase(),
      paneId: paneId.toUpperCase(),
      surfaceId: surfaceId.toUpperCase()
    };

    const result = new AttentionEngine().build(
      [session],
      [task("active")],
      [uppercaseBinding],
      1_000,
      STALE_AFTER_MS
    );

    expect(result.some((item) =>
      item.reasons.some((reason) => reason.kind === "linked-surface-missing")
    )).toBe(false);
  });

  it("reports a binding missing when the surface UUID exists under a different pane", () => {
    const session: LiveSession = {
      key: `${binding.workspaceId}:${binding.surfaceId}`,
      workspaceId: binding.workspaceId,
      paneId: "55555555-5555-4555-8555-555555555555",
      surfaceId: binding.surfaceId,
      workspaceTitle: "Workspace",
      workspaceIndex: 0,
      paneIndex: 1,
      surfaceIndex: 0,
      surfaceTitle: "Surface",
      surfaceType: "terminal",
      currentDirectory: "/repo",
      provider: {
        provider: "codex",
        confidence: "medium",
        source: "screen-preview",
        explanation: "fixture",
        sessionId: null
      },
      assessment: assessment("unknown"),
      observedAt: 1_000,
      notifications: [],
      linkedTaskId: null,
      conversation: null,
      preview: null
    };

    const result = new AttentionEngine().build(
      [session],
      [task("active")],
      [binding],
      1_000,
      STALE_AFTER_MS
    );

    expect(result.some((item) =>
      item.reasons.some((reason) => reason.kind === "linked-surface-missing")
    )).toBe(true);
  });

  it("reports when exact evidence proves that a bound surface now hosts another provider conversation", () => {
    const work = task("active");
    const oldSessionId = "55555555-5555-4555-8555-555555555555";
    const newSessionId = "66666666-6666-4666-8666-666666666666";
    const reusedSurface: LiveSession = {
      key: `${binding.workspaceId}:${binding.surfaceId}`,
      workspaceId: binding.workspaceId,
      paneId: binding.paneId,
      surfaceId: binding.surfaceId,
      workspaceTitle: "Workspace",
      workspaceIndex: 0,
      paneIndex: 0,
      surfaceIndex: 0,
      surfaceTitle: "Surface",
      surfaceType: "terminal",
      currentDirectory: "/repo",
      provider: {
        provider: "codex",
        confidence: "high",
        source: "codex-writer-lock",
        explanation: "Verified a different exact writer.",
        sessionId: newSessionId
      },
      assessment: assessment("unknown"),
      observedAt: 1_000,
      notifications: [],
      linkedTaskId: null,
      conversation: null,
      preview: null
    };

    const result = new AttentionEngine().build(
      [reusedSurface],
      [work],
      [{ ...binding, providerSessionId: oldSessionId }],
      1_000,
      STALE_AFTER_MS
    );

    expect(result).toMatchObject([
      {
        key: `task:${work.taskId}`,
        session: null,
        task: { taskId: work.taskId, workflowStatus: "active" },
        reasons: [
          {
            kind: "linked-session-changed",
            confidence: "high",
            severity: 3
          }
        ]
      }
    ]);
    expect(work.workflowStatus).toBe("active");
  });

  it("does not claim a provider-session change from heuristic evidence", () => {
    const heuristic = {
      ...liveSession("heuristic", assessment("unknown")),
      workspaceId: binding.workspaceId,
      paneId: binding.paneId,
      surfaceId: binding.surfaceId,
      provider: {
        provider: "codex" as const,
        confidence: "medium" as const,
        source: "screen-preview" as const,
        explanation: "Screen text resembles Codex.",
        sessionId: "66666666-6666-4666-8666-666666666666"
      }
    };

    expect(
      new AttentionEngine().build(
        [heuristic],
        [task("active")],
        [{
          ...binding,
          providerSessionId: "55555555-5555-4555-8555-555555555555"
        }],
        1_000,
        STALE_AFTER_MS
      )
    ).toEqual([]);
  });

  it("sorts runtime errors above generic unread notifications", () => {
    const base: Omit<LiveSession, "key" | "surfaceId" | "assessment" | "notifications"> = {
      workspaceId: "workspace",
      paneId: "pane",
      workspaceTitle: "Workspace",
      workspaceIndex: 0,
      paneIndex: 0,
      surfaceIndex: 0,
      surfaceTitle: "Surface",
      surfaceType: "terminal",
      currentDirectory: null,
      provider: { provider: "unknown", confidence: "low", source: "none", explanation: "unknown", sessionId: null },
      observedAt: 1_000,
      linkedTaskId: null,
      conversation: null,
      preview: null
    };
    const sessions: LiveSession[] = [
      {
        ...base,
        key: "generic",
        surfaceId: "generic",
        assessment: assessment("unknown"),
        notifications: [
          { id: "n1", workspaceId: "workspace", surfaceId: "generic", title: "Notice", subtitle: "", body: "Update", isRead: false }
        ]
      },
      {
        ...base,
        key: "error",
        surfaceId: "error",
        assessment: assessment("failed"),
        notifications: []
      }
    ];
    const result = new AttentionEngine().build(sessions, [], [], 1_000, STALE_AFTER_MS);
    expect(result.map((item) => item.key)).toEqual(["error", "generic"]);
  });

  it("flags only structured working sessions whose proven activity exceeds the threshold", () => {
    const now = 2_000_000;
    const stale = liveSession("stale", assessment("working", {
      coverage: "structured",
      confidence: "high",
      lastActivityAt: now - STALE_AFTER_MS
    }));
    const recent = liveSession("recent", assessment("working", {
      coverage: "structured",
      confidence: "high",
      lastActivityAt: now - STALE_AFTER_MS + 1
    }));
    const idle = liveSession("idle", assessment("idle", {
      coverage: "structured",
      lastActivityAt: now - STALE_AFTER_MS - 1
    }));
    const unknown = liveSession("unknown", assessment("unknown", {
      lastActivityAt: now - STALE_AFTER_MS - 1
    }));

    const result = new AttentionEngine().build(
      [stale, recent, idle, unknown],
      [],
      [],
      now,
      STALE_AFTER_MS
    );

    expect(result).toMatchObject([
      {
        key: "stale",
        reasons: [
          {
            kind: "stale",
            label: "Working state may be stale",
            severity: 2,
            confidence: "medium"
          }
        ]
      }
    ]);
    expect(result[0]?.reasons[0]?.detail).toContain("30 minutes");
  });

  it("does not infer staleness from fallback evidence even when its activity is old", () => {
    const now = 2_000_000;
    const session = liveSession("fallback", assessment("working", {
      coverage: "fallback",
      lastActivityAt: now - STALE_AFTER_MS - 1
    }));

    expect(new AttentionEngine().build([session], [], [], now, STALE_AFTER_MS)).toEqual([]);
  });

  it("surfaces finished agent output for review without changing workflow", () => {
    const work = task("active");
    const session = {
      ...liveSession("finished", assessment("turn-finished", {
        coverage: "structured",
        confidence: "high",
        explanation: "cmux reports that the provider turn completed."
      })),
      linkedTaskId: work.taskId
    };

    const result = new AttentionEngine().build(
      [session],
      [work],
      [],
      2_000_000,
      STALE_AFTER_MS
    );

    expect(result).toMatchObject([
      {
        task: { taskId: work.taskId, workflowStatus: "active" },
        reasons: [
          {
            kind: "review-ready",
            label: "Agent output may be ready for review",
            severity: 3,
            confidence: "high"
          }
        ]
      }
    ]);
    expect(work.workflowStatus).toBe("active");
  });

  it("does not promote an unsupported fallback turn-finished claim into attention", () => {
    const session = liveSession("fallback-finished", assessment("turn-finished", {
      coverage: "fallback",
      confidence: "low"
    }));

    expect(new AttentionEngine().build([session], [], [], 2_000_000, STALE_AFTER_MS)).toEqual([]);
  });
});

function assessment(
  phase: LiveSession["assessment"]["executionPhase"],
  overrides: Partial<LiveSession["assessment"]> = {}
): LiveSession["assessment"] {
  return {
    surfacePresence: "present",
    agentPresence: "unknown",
    executionPhase: phase,
    activity: "unknown",
    coverage: phase === "unknown" ? "fallback" : "partial",
    confidence: phase === "unknown" ? "low" : "medium",
    source: phase === "unknown" ? "cmux-topology" : "cmux-notification",
    explanation: phase === "failed" ? "error" : "unknown",
    updatedAt: 1_000,
    lastActivityAt: null,
    primaryEvidenceId: null,
    ...overrides
  };
}

function liveSession(key: string, sessionAssessment: LiveSession["assessment"]): LiveSession {
  return {
    key,
    workspaceId: "workspace",
    paneId: "pane",
    surfaceId: key,
    workspaceTitle: "Workspace",
    workspaceIndex: 0,
    paneIndex: 0,
    surfaceIndex: 0,
    surfaceTitle: key,
    surfaceType: "terminal",
    currentDirectory: "/repo",
    provider: {
      provider: "codex",
      confidence: "high",
      source: "cmux-agent-registry",
      explanation: "fixture",
      sessionId: "session"
    },
    assessment: sessionAssessment,
    observedAt: sessionAssessment.updatedAt,
    notifications: [],
    linkedTaskId: null,
    conversation: null,
    preview: null
  };
}
