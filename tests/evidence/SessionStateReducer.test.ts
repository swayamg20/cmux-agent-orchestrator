import { describe, expect, it } from "vitest";
import { reduceSessionEvidence } from "../../src/evidence/SessionStateReducer";
import type { SessionEvidence } from "../../src/evidence/types";

const key = "workspace:surface";

function present(observedAt = 1_000): SessionEvidence {
  return {
    id: "present",
    kind: "surface-present",
    sessionKey: key,
    source: "cmux-topology",
    authority: "presence",
    confidence: "high",
    observedAt,
    occurredAt: observedAt,
    summary: "present"
  };
}

describe("reduceSessionEvidence", () => {
  it("keeps execution unknown when only a cmux surface is present", () => {
    const result = reduceSessionEvidence([present()], 1_000);
    expect(result).toMatchObject({
      surfacePresence: "present",
      agentPresence: "unknown",
      executionPhase: "unknown",
      coverage: "fallback"
    });
  });

  it("treats a screen change as recent activity without claiming the agent is working", () => {
    const result = reduceSessionEvidence([
      present(),
      {
        id: "screen",
        kind: "screen-observed",
        sessionKey: key,
        source: "terminal-preview",
        authority: "heuristic",
        confidence: "low",
        observedAt: 1_100,
        occurredAt: 1_100,
        summary: "changed",
        changed: true,
        activity: "editing",
        fingerprint: "abc"
      }
    ], 1_100);
    expect(result.executionPhase).toBe("unknown");
    expect(result.activity).toBe("editing");
    expect(result.lastActivityAt).toBe(1_100);
  });

  it("uses unread notification evidence without marking durable work done", () => {
    const result = reduceSessionEvidence([
      present(),
      {
        id: "notification",
        kind: "notification",
        sessionKey: key,
        source: "cmux-notification",
        authority: "notification",
        confidence: "medium",
        observedAt: 1_200,
        occurredAt: null,
        summary: "review",
        notificationId: "n1",
        signal: "turn-finished",
        unread: true
      }
    ], 1_200);
    expect(result.executionPhase).toBe("turn-finished");
    expect(result.coverage).toBe("partial");
  });

  it("allows structured lifecycle evidence to outrank heuristics", () => {
    const result = reduceSessionEvidence([
      present(),
      {
        id: "lifecycle",
        kind: "lifecycle",
        sessionKey: key,
        source: "provider-lifecycle",
        authority: "structured",
        confidence: "high",
        observedAt: 1_300,
        occurredAt: 1_250,
        summary: "turn started",
        signal: "turn-started",
        activity: "reasoning",
        provider: "codex",
        providerSessionId: "thread"
      }
    ], 1_300);
    expect(result).toMatchObject({
      agentPresence: "attached",
      executionPhase: "working",
      activity: "reasoning",
      coverage: "structured",
      confidence: "high"
    });
  });

  it("keeps provider idle separate from workflow completion", () => {
    const result = reduceSessionEvidence([
      present(),
      {
        id: "idle",
        kind: "lifecycle",
        sessionKey: key,
        source: "provider-lifecycle",
        authority: "structured",
        confidence: "high",
        observedAt: 1_400,
        occurredAt: 1_350,
        summary: "provider idle",
        signal: "session-idle",
        activity: "unknown",
        provider: "codex",
        providerSessionId: "thread"
      }
    ], 1_400);

    expect(result).toMatchObject({
      agentPresence: "attached",
      executionPhase: "idle",
      coverage: "structured"
    });
  });
});
