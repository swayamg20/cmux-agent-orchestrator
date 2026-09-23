import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { FEEDBACK_LINKS } from "../../src/support/FeedbackLinks";

interface IssueConfig {
  blank_issues_enabled?: unknown;
  contact_links?: Array<{ name?: unknown; url?: unknown; about?: unknown }>;
}

interface IssueForm {
  name?: unknown;
  description?: unknown;
  body?: unknown;
}

async function readRepositoryFile(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("feedback surfaces", () => {
  it("uses fixed HTTPS destinations owned by the project repository", () => {
    for (const value of Object.values(FEEDBACK_LINKS)) {
      const url = new URL(value);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("github.com");
      expect(url.pathname).toMatch(/^\/swayamg20\/cmux-agent-orchestrator\//);
    }
    expect(new URL(FEEDBACK_LINKS.bug).searchParams.get("template")).toBe("bug.yml");
    expect(new URL(FEEDBACK_LINKS.compatibility).searchParams.get("template"))
      .toBe("compatibility.yml");
  });

  it("keeps GitHub contact routing aligned with the in-plugin destinations", async () => {
    const config = parseYaml(
      await readRepositoryFile(".github/ISSUE_TEMPLATE/config.yml")
    ) as IssueConfig;
    const urls = config.contact_links?.map((link) => link.url) ?? [];

    expect(config.blank_issues_enabled).toBe(false);
    expect(urls).toEqual([
      FEEDBACK_LINKS.idea,
      FEEDBACK_LINKS.question,
      FEEDBACK_LINKS.security
    ]);
  });

  it("keeps both structured issue forms present and usable", async () => {
    const forms = await Promise.all(
      ["bug.yml", "compatibility.yml"].map(async (name) =>
        parseYaml(await readRepositoryFile(`.github/ISSUE_TEMPLATE/${name}`)) as IssueForm
      )
    );

    for (const form of forms) {
      expect(form.name).toEqual(expect.any(String));
      expect(form.description).toEqual(expect.any(String));
      expect(Array.isArray(form.body)).toBe(true);
      expect((form.body as unknown[]).length).toBeGreaterThan(1);
    }
  });

  it("documents the no-telemetry and private-security boundaries", async () => {
    const [support, security, readme] = await Promise.all([
      readRepositoryFile("SUPPORT.md"),
      readRepositoryFile("SECURITY.md"),
      readRepositoryFile("README.md")
    ]);

    expect(support).toContain("Nothing is transmitted automatically.");
    expect(security).toContain(FEEDBACK_LINKS.security);
    expect(readme).toContain("no runtime npm dependencies, telemetry, hosted service");
  });
});
