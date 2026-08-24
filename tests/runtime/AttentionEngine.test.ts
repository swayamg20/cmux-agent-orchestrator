import { describe, expect, it } from "vitest";
import { AttentionEngine } from "../../src/runtime/AttentionEngine";
import type { BindingRecord } from "../../src/bindings/types";
import type { LiveSession } from "../../src/state/types";
import type { TaskRecord } from "../../src/tasks/TaskSchema";

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
    const result = new AttentionEngine().build([], [work], [binding], 1_000);
    expect(result[0]?.reasons[0]?.kind).toBe("linked-surface-missing");
    expect(work.workflowStatus).toBe("active");
  });

  it("includes durable review tasks even without a live session", () => {
    const result = new AttentionEngine().build([], [task("review")], [], 1_000);
    expect(result.some((item) => item.reasons.some((reason) => reason.kind === "review-ready"))).toBe(true);
  });

  it("sorts runtime errors above generic unread notifications", () => {
    const base: Omit<LiveSession, "key" | "surfaceId" | "runtime" | "notifications"> = {
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
      preview: null
    };
    const sessions: LiveSession[] = [
      {
        ...base,
        key: "generic",
        surfaceId: "generic",
        runtime: {
          state: "unknown",
          evidence: { source: "surface-presence", confidence: "low", observedAt: 1_000, explanation: "unknown" },
          lastObservedChangeAt: null
        },
        notifications: [
          { id: "n1", workspaceId: "workspace", surfaceId: "generic", title: "Notice", subtitle: "", body: "Update", isRead: false }
        ]
      },
      {
        ...base,
        key: "error",
        surfaceId: "error",
        runtime: {
          state: "error",
          evidence: { source: "cmux-notification", confidence: "medium", observedAt: 1_000, explanation: "error" },
          lastObservedChangeAt: null
        },
        notifications: []
      }
    ];
    const result = new AttentionEngine().build(sessions, [], [], 1_000);
    expect(result.map((item) => item.key)).toEqual(["error", "generic"]);
  });
});
