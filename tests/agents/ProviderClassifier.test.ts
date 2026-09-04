import { describe, expect, it } from "vitest";
import { AgentDetector } from "../../src/agents/AgentDetector";
import { ProviderClassifier } from "../../src/agents/ProviderClassifier";
import type { CmuxClient } from "../../src/cmux/CmuxClient";
import { PreviewScheduler } from "../../src/runtime/PreviewScheduler";
import type { LiveSession } from "../../src/state/types";

const session = {
  key: "workspace:pane:surface",
  workspaceId: "workspace",
  paneId: "pane",
  surfaceId: "surface",
  workspaceTitle: "repository",
  workspaceIndex: 0,
  paneIndex: 0,
  surfaceIndex: 0,
  surfaceTitle: "repository",
  surfaceType: "terminal",
  currentDirectory: "/repository",
  provider: {
    provider: "unknown",
    confidence: "low",
    source: "none",
    explanation: "No provider evidence.",
    sessionId: null
  }
} as LiveSession;

describe("ProviderClassifier", () => {
  it("retries a surface after a transient bounded-preview failure", async () => {
    const scheduler = new PreviewScheduler(1);
    const classifier = new ProviderClassifier(new AgentDetector(), scheduler);
    let reads = 0;
    const client = {
      readPreview: async () => {
        reads += 1;
        if (reads === 1) throw new Error("transient read-screen failure");
        return {
          workspaceId: session.workspaceId,
          surfaceId: session.surfaceId,
          text: "• Ran npm test\n  └ Tests passed",
          observedAt: 2,
          truncated: false
        };
      }
    } as unknown as CmuxClient;

    await expect(classifier.classifyNew([session], client)).resolves.toEqual([]);
    await expect(classifier.classifyNew([session], client)).resolves.toMatchObject([
      { key: session.key, detection: { provider: "codex", source: "screen-preview" } }
    ]);
    expect(reads).toBe(2);
    scheduler.dispose();
  });

  it("does not repeatedly read a successful but inconclusive preview", async () => {
    const scheduler = new PreviewScheduler(1);
    const classifier = new ProviderClassifier(new AgentDetector(), scheduler);
    let reads = 0;
    const client = {
      readPreview: async () => {
        reads += 1;
        return {
          workspaceId: session.workspaceId,
          surfaceId: session.surfaceId,
          text: "plain shell output",
          observedAt: 3,
          truncated: false
        };
      }
    } as unknown as CmuxClient;

    await expect(classifier.classifyNew([session], client)).resolves.toEqual([]);
    expect(classifier.classifyNew([session], client)).toBeNull();
    expect(reads).toBe(1);
    scheduler.dispose();
  });
});
