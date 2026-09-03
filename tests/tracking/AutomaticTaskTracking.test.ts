import { describe, expect, it } from "vitest";
import type { AgentRunRecord } from "../../src/bindings/types";
import type { LiveSession, ProviderDetection } from "../../src/state/types";
import {
  automaticTaskId,
  automaticTaskTitle,
  selectAutomaticTrackCandidates
} from "../../src/tracking/AutomaticTaskTracking";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PANE_ID = "22222222-2222-4222-8222-222222222222";
const CODEX_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const CLAUDE_SESSION_ID = "44444444-4444-4444-8444-444444444444";

function session(
  surfaceId: string,
  provider: ProviderDetection,
  linkedTaskId: string | null = null
): LiveSession {
  return {
    key: `${WORKSPACE_ID}:${PANE_ID}:${surfaceId}`,
    workspaceId: WORKSPACE_ID,
    paneId: PANE_ID,
    surfaceId,
    workspaceTitle: "Private workspace title",
    workspaceIndex: 0,
    paneIndex: 0,
    surfaceIndex: 0,
    surfaceTitle: "Private surface title",
    surfaceType: "terminal",
    currentDirectory: "/Users/person/code/sample-repository",
    provider,
    assessment: {
      surfacePresence: "present",
      agentPresence: "attached",
      executionPhase: "working",
      activity: "command",
      coverage: "structured",
      confidence: "high",
      source: "provider-lifecycle",
      explanation: "fixture",
      updatedAt: 1_000,
      lastActivityAt: 1_000,
      primaryEvidenceId: "evidence"
    },
    observedAt: 1_000,
    notifications: [],
    linkedTaskId,
    conversation: {
      provider: provider.provider === "claude" ? "claude" : "codex",
      sessionId: provider.sessionId ?? CODEX_SESSION_ID,
      title: "Secret provider conversation title",
      titleSource: "provider-preview",
      cwd: "/Users/person/code/sample-repository",
      updatedAt: 1_000,
      status: "active",
      matchSource: "codex-writer-lock",
      matchConfidence: "high"
    },
    preview: null
  };
}

function exactProvider(
  provider: "claude" | "codex",
  sessionId: string,
  source: ProviderDetection["source"] = "provider-session-mapping"
): ProviderDetection {
  return {
    provider,
    confidence: "high",
    source,
    explanation: "Exact fixture identity",
    sessionId
  };
}

describe("automatic task tracking policy", () => {
  it("selects unique exact Claude and Codex sessions with deterministic task IDs", () => {
    const codex = session(
      "55555555-5555-4555-8555-555555555555",
      exactProvider("codex", CODEX_SESSION_ID, "codex-writer-lock")
    );
    const claude = session(
      "66666666-6666-4666-8666-666666666666",
      exactProvider("claude", CLAUDE_SESSION_ID, "claude-process-registry")
    );

    const candidates = selectAutomaticTrackCandidates([codex, claude], []);

    expect(candidates).toHaveLength(2);
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "codex",
          providerSessionId: CODEX_SESSION_ID,
          taskId: automaticTaskId("codex", CODEX_SESSION_ID)
        }),
        expect.objectContaining({
          provider: "claude",
          providerSessionId: CLAUDE_SESSION_ID,
          taskId: automaticTaskId("claude", CLAUDE_SESSION_ID)
        })
      ])
    );
    expect(candidates.every((candidate) => /^[0-9a-f-]{36}$/.test(candidate.taskId))).toBe(true);
  });

  it("fails closed for heuristic, ambiguous, invalid, linked, or duplicate identities", () => {
    const duplicateA = session(
      "55555555-5555-4555-8555-555555555555",
      exactProvider("codex", CODEX_SESSION_ID, "cmux-agent-registry")
    );
    const duplicateB = session(
      "66666666-6666-4666-8666-666666666666",
      exactProvider("codex", CODEX_SESSION_ID, "codex-writer-lock")
    );
    const heuristic = session("77777777-7777-4777-8777-777777777777", {
      ...exactProvider("claude", CLAUDE_SESSION_ID),
      confidence: "medium",
      source: "screen-preview"
    });
    const invalid = session(
      "88888888-8888-4888-8888-888888888888",
      exactProvider("claude", "not-a-uuid", "claude-process-registry")
    );
    const linked = session(
      "99999999-9999-4999-8999-999999999999",
      exactProvider("claude", CLAUDE_SESSION_ID),
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    );

    expect(selectAutomaticTrackCandidates([duplicateA, duplicateB, heuristic, invalid, linked], [])).toEqual([]);
  });

  it("uses retained run history as a tombstone after detach or task removal", () => {
    const codex = session(
      "55555555-5555-4555-8555-555555555555",
      exactProvider("codex", CODEX_SESSION_ID, "codex-writer-lock")
    );
    const run: AgentRunRecord = {
      runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      taskId: automaticTaskId("codex", CODEX_SESSION_ID),
      provider: "codex",
      providerSessionId: CODEX_SESSION_ID,
      relation: "initial",
      parentRunId: null,
      firstAttachedAt: "2026-09-04T00:00:00.000Z",
      lastAttachedAt: "2026-09-04T00:00:00.000Z"
    };

    expect(selectAutomaticTrackCandidates([codex], [run])).toEqual([]);
  });

  it("keeps private conversation and cmux titles out of automatic Markdown titles", () => {
    const codex = session(
      "55555555-5555-4555-8555-555555555555",
      exactProvider("codex", CODEX_SESSION_ID)
    );

    const title = automaticTaskTitle(codex, "codex");

    expect(title).toBe("Codex run · sample-repository");
    expect(title).not.toContain("Secret provider conversation title");
    expect(title).not.toContain("Private surface title");
    expect(automaticTaskId("codex", CODEX_SESSION_ID)).toBe(
      automaticTaskId("codex", CODEX_SESSION_ID)
    );
    expect(automaticTaskId("codex", CODEX_SESSION_ID)).not.toBe(
      automaticTaskId("claude", CODEX_SESSION_ID)
    );
  });
});
