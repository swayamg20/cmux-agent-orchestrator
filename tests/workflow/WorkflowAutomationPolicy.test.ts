import { describe, expect, it } from "vitest";
import type { LiveSession } from "../../src/state/types";
import type { TaskRecord } from "../../src/tasks/TaskSchema";
import { evaluateWorkflowProposal } from "../../src/workflow/WorkflowAutomationPolicy";

const NOW = Date.parse("2026-09-06T04:00:00.000Z");

function task(workflowStatus: TaskRecord["workflowStatus"]): TaskRecord {
  return {
    file: { path: "Agent Cockpit/Tasks/task.md", basename: "task" } as TaskRecord["file"],
    taskId: "11111111-1111-4111-8111-111111111111",
    title: "Investigate provider state",
    workflowStatus,
    priority: "normal",
    repository: "repo",
    branch: null,
    worktree: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    runCount: 1
  };
}

function session(overrides: Partial<LiveSession["assessment"]> = {}): LiveSession {
  return {
    key: "workspace:pane:surface",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    paneId: "33333333-3333-4333-8333-333333333333",
    surfaceId: "44444444-4444-4444-8444-444444444444",
    workspaceTitle: "repo",
    workspaceIndex: 0,
    paneIndex: 0,
    surfaceIndex: 0,
    surfaceTitle: "codex",
    surfaceType: "terminal",
    currentDirectory: "/repo",
    provider: {
      provider: "codex",
      confidence: "high",
      source: "cmux-agent-registry",
      explanation: "Exact Codex session",
      sessionId: "55555555-5555-4555-8555-555555555555"
    },
    assessment: {
      surfacePresence: "present",
      agentPresence: "attached",
      executionPhase: "turn-finished",
      activity: "unknown",
      coverage: "structured",
      confidence: "high",
      source: "provider-lifecycle",
      explanation: "Codex completed the turn.",
      updatedAt: NOW,
      lastActivityAt: NOW,
      primaryEvidenceId: "evidence-1",
      ...overrides
    },
    observedAt: NOW,
    notifications: [],
    linkedTaskId: "11111111-1111-4111-8111-111111111111",
    conversation: null,
    preview: null
  };
}

function evaluate(
  workflowStatus: TaskRecord["workflowStatus"],
  mode: "off" | "suggest" | "safe-auto",
  candidate = session(),
  exactBinding = true,
  now = NOW
) {
  return evaluateWorkflowProposal({
    task: task(workflowStatus),
    session: candidate,
    exactBinding,
    mode,
    now
  });
}

describe("WorkflowAutomationPolicy", () => {
  it("suggests Active to Review for credible completed-turn evidence", () => {
    expect(evaluate("active", "suggest")).toMatchObject({
      from: "active",
      to: "review",
      reason: "turn-finished",
      applyAutomatically: false
    });
  });

  it("allows only fresh high-confidence structured completion evidence to auto-apply", () => {
    expect(evaluate("active", "safe-auto")).toMatchObject({
      to: "review",
      applyAutomatically: true
    });
    expect(
      evaluate("active", "safe-auto", session({ coverage: "partial", source: "cmux-notification" }))
    ).toMatchObject({ to: "review", applyAutomatically: false });
    expect(
      evaluate("active", "safe-auto", session({ confidence: "medium" }))
    ).toMatchObject({ to: "review", applyAutomatically: false });
    expect(evaluate("active", "safe-auto", session(), true, NOW + 6 * 60_000)).toMatchObject({
      to: "review",
      applyAutomatically: false
    });
  });

  it("suggests but never auto-applies Backlog activation for an exact live run", () => {
    expect(evaluate("backlog", "safe-auto")).toMatchObject({
      from: "backlog",
      to: "active",
      reason: "exact-run-attached",
      applyAutomatically: false
    });
  });

  it("suggests but never auto-applies Review to Active when work resumes", () => {
    const working = session({ executionPhase: "working" });
    expect(evaluate("review", "safe-auto", working)).toMatchObject({
      from: "review",
      to: "active",
      reason: "work-resumed",
      applyAutomatically: false
    });
  });

  it.each(["parked", "done"] as const)("protects manually controlled %s tasks", (status) => {
    expect(evaluate(status, "safe-auto")).toBeNull();
  });

  it("fails closed when automation is off or the binding is not exact", () => {
    expect(evaluate("active", "off")).toBeNull();
    expect(evaluate("active", "suggest", session(), false)).toBeNull();
  });

  it("does not propose moves from low-confidence, missing, or stale evidence", () => {
    expect(evaluate("active", "suggest", session({ confidence: "low" }))).toBeNull();
    expect(
      evaluate("active", "suggest", session({ primaryEvidenceId: null }))
    ).toBeNull();
    expect(evaluate("active", "suggest", session(), true, NOW + 31 * 60_000)).toBeNull();
  });

  it.each(["unknown", "waiting", "idle", "failed"] as const)(
    "does not interpret %s as workflow completion",
    (executionPhase) => {
      expect(evaluate("active", "safe-auto", session({ executionPhase }))).toBeNull();
    }
  );

  it("requires the session to be linked to the same task", () => {
    const other = session();
    other.linkedTaskId = "66666666-6666-4666-8666-666666666666";
    expect(evaluate("active", "suggest", other)).toBeNull();
  });
});
