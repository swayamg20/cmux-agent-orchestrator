import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeSessionSource } from "../../src/providers/ClaudeSessionSource";
import { CodexAppServerSource } from "../../src/providers/CodexAppServerSource";
import type { ProviderSessionSource } from "../../src/providers/types";
import { isCanonicalUuid } from "../../src/security/identifiers";

const live = process.env.CMUX_AGENT_ORCHESTRATOR_LIVE_PROVIDERS === "1" ? describe : describe.skip;

live("installed provider metadata read-only smoke", () => {
  it("reads bounded local Codex and Claude title metadata without changing sessions", async () => {
    const cwd = path.resolve(process.cwd());
    const sources: ProviderSessionSource[] = [new CodexAppServerSource(), new ClaudeSessionSource()];
    try {
      const results = await Promise.all(sources.map((source) => source.list(cwd)));
      expect(results.flat().length).toBeGreaterThan(0);
      for (const sessions of results) {
        expect(sessions.length).toBeLessThanOrEqual(200);
        for (const session of sessions) {
          expect(isCanonicalUuid(session.sessionId)).toBe(true);
          expect(session.cwd).toBe(cwd);
          expect(session.title.length).toBeGreaterThan(0);
          expect(Array.from(session.title).length).toBeLessThanOrEqual(120);
        }
      }
    } finally {
      for (const source of sources) source.dispose();
    }
  });
});
