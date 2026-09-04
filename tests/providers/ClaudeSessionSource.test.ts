import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ClaudeSessionSource,
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

  it("rejects a transcript title unless the transcript proves the exact requested CWD", async () => {
    const claudeRoot = await mkdtemp(path.join(tmpdir(), "claude-session-source-"));
    const transcriptCwd = "/repo/a-b/c";
    const collidingCwd = "/repo/a/b-c";
    const sessionId = "44444444-4444-4444-8444-444444444444";
    try {
      const projectDirectory = claudeProjectDirectory(claudeRoot, transcriptCwd);
      expect(projectDirectory).toBe(claudeProjectDirectory(claudeRoot, collidingCwd));
      await mkdir(projectDirectory, { recursive: true });
      await writeFile(
        path.join(projectDirectory, `${sessionId}.jsonl`),
        [
          JSON.stringify({ type: "user", sessionId, cwd: transcriptCwd }),
          JSON.stringify({ type: "ai-title", sessionId, aiTitle: "Exact Claude title" })
        ].join("\n"),
        "utf8"
      );
      const source = new ClaudeSessionSource(claudeRoot);

      await expect(source.get(sessionId, collidingCwd)).resolves.toBeNull();
      await expect(source.get(sessionId, transcriptCwd)).resolves.toMatchObject({
        sessionId,
        cwd: transcriptCwd,
        title: "Exact Claude title"
      });
    } finally {
      await rm(claudeRoot, { recursive: true, force: true });
    }
  });
});
