import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  claudeProjectDirectory,
  decodeClaudeSession,
  decodeClaudeTitleRecords
} from "../../src/providers/ClaudeSessionSource";

const fixture = (name: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`../fixtures/providers/${name}`, import.meta.url)), "utf8");

describe("ClaudeSessionSource", () => {
  it("decodes the active-session registry only for the exact working directory", async () => {
    const raw = JSON.parse(await fixture("claude-session.json")) as unknown;
    expect(decodeClaudeSession(raw, "/workspace/project", 100)).toMatchObject({
      provider: "claude",
      sessionId: "44444444-4444-4444-8444-444444444444",
      title: "project-title",
      titleSource: "session-name",
      status: "waiting"
    });
    expect(decodeClaudeSession(raw, "/workspace/other", 100)).toBeNull();
  });

  it("uses an exact-session custom title without ingesting message records", async () => {
    const title = decodeClaudeTitleRecords(
      await fixture("claude-titles.jsonl"),
      "44444444-4444-4444-8444-444444444444"
    );
    expect(title).toEqual({ title: "Provider conversation titles", titleSource: "explicit-name" });
  });

  it("constructs the provider-owned project path without accepting a relative CWD", () => {
    expect(claudeProjectDirectory("/home/test/.claude", "/workspace/project")).toBe(
      "/home/test/.claude/projects/-workspace-project"
    );
    expect(() => claudeProjectDirectory("/home/test/.claude", "../project")).toThrow(/absolute/);
  });
});
