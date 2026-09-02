import { describe, expect, it } from "vitest";
import { taskTitleFromSession } from "../../src/components/TaskModals";
import type { LiveSession } from "../../src/state/types";

describe("taskTitleFromSession", () => {
  it("does not copy an in-memory provider title into a durable Markdown task", () => {
    const session = {
      surfaceTitle: "project",
      currentDirectory: "/workspace/project",
      conversation: {
        provider: "codex",
        sessionId: "55555555-5555-4555-8555-555555555555",
        title: "Private provider conversation title",
        titleSource: "explicit-name",
        cwd: "/workspace/project",
        updatedAt: 1_000,
        status: "idle",
        matchSource: "manual",
        matchConfidence: "high"
      }
    } as LiveSession;

    expect(taskTitleFromSession(session)).toBe("project: project");
  });
});
