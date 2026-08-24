import { describe, expect, it } from "vitest";
import { AgentDetector } from "../../src/agents/AgentDetector";
import type { CmuxSurface } from "../../src/cmux/types";

const surface = (title: string): CmuxSurface => ({
  id: "surface",
  paneId: "pane",
  index: 0,
  indexInPane: 0,
  title,
  type: "terminal",
  selected: false,
  focused: false,
  active: false
});

describe("AgentDetector", () => {
  it("uses explicit title evidence for providers", () => {
    const detector = new AgentDetector();
    expect(detector.detect(surface("Claude Code · repo")).provider).toBe("claude");
    expect(detector.detect(surface("Codex · repo")).provider).toBe("codex");
  });

  it("does not invent provider session IDs", () => {
    const detection = new AgentDetector().detect(surface("repo"));
    expect(detection.provider).toBe("unknown");
    expect(detection.sessionId).toBeNull();
  });

  it("does not classify repository-name fragments as high-confidence providers", () => {
    const detector = new AgentDetector();
    expect(detector.detect(surface("codex-dis")).provider).toBe("unknown");
    expect(detector.detect(surface("claude-tools")).provider).toBe("unknown");
  });

  it("recognizes the bounded Codex TUI output emitted by normal tool runs", () => {
    const detection = new AgentDetector().detect(
      surface("repository"),
      "• The final audit passed.\n\n• Ran set -e\n  └ npm test"
    );

    expect(detection).toMatchObject({
      provider: "codex",
      confidence: "medium",
      source: "screen-preview"
    });
  });

  it("recognizes Claude TUI glyphs without requiring the provider name", () => {
    const detection = new AgentDetector().detect(
      surface("repository"),
      "⏺ Read(src/main.ts)\n  ⎿ Read 40 lines"
    );

    expect(detection).toMatchObject({
      provider: "claude",
      confidence: "medium",
      source: "screen-preview"
    });
  });

  it("does not classify prose that merely discusses both provider products", () => {
    const detection = new AgentDetector().detect(
      surface("repository"),
      "The README compares Claude Code with the Codex CLI."
    );

    expect(detection.provider).toBe("unknown");
  });
});
