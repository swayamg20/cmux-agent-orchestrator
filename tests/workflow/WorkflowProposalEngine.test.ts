import { describe, expect, it } from "vitest";
import type { BindingRecord } from "../../src/bindings/types";
import type { LiveSession } from "../../src/state/types";
import type { TaskRecord } from "../../src/tasks/TaskSchema";
import { buildWorkflowProposals } from "../../src/workflow/WorkflowProposalEngine";

const NOW = Date.parse("2026-09-06T04:00:00.000Z");
const FRESH_HEALTH = {
  connected: true,
  topologyFresh: true,
  lifecycleFresh: true,
  notificationsFresh: true
};

function task(): TaskRecord {
  return {
    file: { path: "Agent Cockpit/Tasks/task.md", basename: "task" } as TaskRecord["file"],
    taskId: "11111111-1111-4111-8111-111111111111",
    title: "Review provider output",
    workflowStatus: "active",
    priority: "normal",
    repository: "/repo",
    branch: null,
    worktree: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    runCount: 1
  };
}

function session(): LiveSession {
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
      explanation: "Exact native identity",
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
      explanation: "Turn completed",
      updatedAt: NOW,
      lastActivityAt: NOW,
      primaryEvidenceId: "evidence-1"
    },
    observedAt: NOW,
    notifications: [],
    linkedTaskId: "11111111-1111-4111-8111-111111111111",
    conversation: null,
    preview: null
  };
}

function binding(overrides: Partial<BindingRecord> = {}): BindingRecord {
  return {
    bindingId: "66666666-6666-4666-8666-666666666666",
    runId: "77777777-7777-4777-8777-777777777777",
    taskId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    paneId: "33333333-3333-4333-8333-333333333333",
    surfaceId: "44444444-4444-4444-8444-444444444444",
    provider: "codex",
    providerSessionId: "55555555-5555-4555-8555-555555555555",
    attachedAt: new Date(NOW).toISOString(),
    ...overrides
  };
}

function exactWorkingSibling(): { session: LiveSession; binding: BindingRecord } {
  const working = session();
  working.key = "workspace:pane:working-surface";
  working.surfaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  working.provider = {
    ...working.provider,
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  };
  working.assessment = {
    ...working.assessment,
    executionPhase: "working",
    primaryEvidenceId: "evidence-working"
  };
  return {
    session: working,
    binding: binding({
      bindingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      surfaceId: working.surfaceId,
      providerSessionId: working.provider.sessionId
    })
  };
}

describe("WorkflowProposalEngine", () => {
  it("builds one proposal for an exact task, surface, and provider-session binding", () => {
    expect(
      buildWorkflowProposals({
        tasks: [task()],
        sessions: [session()],
        bindings: [binding()],
        dismissals: [],
        mode: "safe-auto",
        now: NOW,
        health: FRESH_HEALTH
      })
    ).toMatchObject([{ taskId: task().taskId, to: "review", applyAutomatically: true }]);
  });

  it.each([
    { taskId: "88888888-8888-4888-8888-888888888888" },
    { surfaceId: "99999999-9999-4999-8999-999999999999" },
    { providerSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { provider: "claude" as const }
  ])("fails closed for a mismatched persisted binding %#", (override) => {
    expect(
      buildWorkflowProposals({
        tasks: [task()],
        sessions: [session()],
        bindings: [binding(override)],
        dismissals: [],
        mode: "safe-auto",
        now: NOW,
        health: FRESH_HEALTH
      })
    ).toEqual([]);
  });

  it("excludes a durably dismissed proposal without hiding later task revisions", () => {
    const first = buildWorkflowProposals({
      tasks: [task()],
      sessions: [session()],
      bindings: [binding()],
      dismissals: [],
      mode: "suggest",
      now: NOW,
      health: FRESH_HEALTH
    })[0]!;
    const dismissal = {
      proposalId: first.id,
      taskId: first.taskId,
      dismissedAt: new Date(NOW).toISOString()
    };
    expect(
      buildWorkflowProposals({
        tasks: [task()],
        sessions: [session()],
        bindings: [binding()],
        dismissals: [dismissal],
        mode: "suggest",
        now: NOW,
        health: FRESH_HEALTH
      })
    ).toEqual([]);

    const revisedTask = { ...task(), updatedAt: new Date(NOW + 1_000).toISOString() };
    expect(
      buildWorkflowProposals({
        tasks: [revisedTask],
        sessions: [session()],
        bindings: [binding()],
        dismissals: [dismissal],
        mode: "suggest",
        now: NOW,
        health: FRESH_HEALTH
      })
    ).toHaveLength(1);
  });

  it("emits at most one deterministic proposal for each task", () => {
    const second = session();
    second.key = "workspace:pane:surface-2";
    second.surfaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondBinding = binding({
      bindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      surfaceId: second.surfaceId
    });
    const proposals = buildWorkflowProposals({
      tasks: [task()],
      sessions: [second, session()],
      bindings: [secondBinding, binding()],
      dismissals: [],
      mode: "suggest",
      now: NOW,
      health: FRESH_HEALTH
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.sessionKey).toBe("workspace:pane:surface");
  });

  it("does not auto-apply Review while another exact linked run is still working", () => {
    const working = exactWorkingSibling();

    const proposals = buildWorkflowProposals({
      tasks: [task()],
      sessions: [session(), working.session],
      bindings: [binding(), working.binding],
      dismissals: [],
      mode: "safe-auto",
      now: NOW,
      health: FRESH_HEALTH
    });

    expect(proposals).toMatchObject([
      {
        sessionKey: "workspace:pane:surface",
        to: "review",
        applyAutomatically: false
      }
    ]);
    expect(proposals[0]?.explanation).toContain("Another exact run is still working");
  });

  it("ignores stale contradictory work when deciding whether Safe auto remains valid", () => {
    const working = exactWorkingSibling();
    working.session.assessment = {
      ...working.session.assessment,
      updatedAt: NOW - 5 * 60_000 - 1
    };

    expect(
      buildWorkflowProposals({
        tasks: [task()],
        sessions: [session(), working.session],
        bindings: [binding(), working.binding],
        dismissals: [],
        mode: "safe-auto",
        now: NOW,
        health: FRESH_HEALTH
      })
    ).toMatchObject([{ to: "review", applyAutomatically: true }]);
  });

  it("removes proposals when their connection or source health becomes stale", () => {
    const input = {
      tasks: [task()],
      sessions: [session()],
      bindings: [binding()],
      dismissals: [],
      mode: "safe-auto" as const,
      now: NOW
    };

    expect(buildWorkflowProposals({ ...input, health: { ...FRESH_HEALTH, connected: false } }))
      .toEqual([]);
    expect(buildWorkflowProposals({ ...input, health: { ...FRESH_HEALTH, topologyFresh: false } }))
      .toEqual([]);
    expect(buildWorkflowProposals({ ...input, health: { ...FRESH_HEALTH, lifecycleFresh: false } }))
      .toEqual([]);
  });
});
