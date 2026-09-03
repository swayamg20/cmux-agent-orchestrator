import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  normalizeTaskFolder,
  parseSettings
} from "../../src/settings/AgentCockpitSettings";

describe("cmux Agent Orchestrator settings", () => {
  it("accepts a normal vault-relative task folder", () => {
    expect(normalizeTaskFolder("Projects/Agent Tasks/")).toBe("Projects/Agent Tasks");
  });

  it.each(["../outside", "safe/../../outside", "/absolute", "safe\\..\\outside", "bad\0folder"])(
    "fails closed for unsafe task folder %j",
    (value) => {
      expect(normalizeTaskFolder(value)).toBe(DEFAULT_SETTINGS.taskFolder);
    }
  );

  it("ignores retired polling settings and bounds preview settings", () => {
    const settings = parseSettings({
      visibleTreePollMs: 1,
      visibleNotificationPollMs: Number.POSITIVE_INFINITY,
      previewLines: 999,
      previewMaxBytes: -1,
      staleAfterMs: 0
    });
    expect(settings).toMatchObject({
      previewLines: DEFAULT_SETTINGS.previewLines,
      previewMaxBytes: DEFAULT_SETTINGS.previewMaxBytes,
      staleAfterMs: DEFAULT_SETTINGS.staleAfterMs
    });
    expect(settings).not.toHaveProperty("visibleTreePollMs");
    expect(settings).not.toHaveProperty("visibleNotificationPollMs");
  });

  it("enables exact automatic task tracking by default and preserves an explicit opt-out", () => {
    expect(parseSettings(undefined).autoTrackAgentRuns).toBe(true);
    expect(parseSettings({ autoTrackAgentRuns: false }).autoTrackAgentRuns).toBe(false);
  });
});
