import { describe, expect, it } from "vitest";
import {
  createRepositoryHubMarkdown,
  normalizeRepositoryIdentity,
  repositoryGraphTarget,
  repositoryHubFolder,
  repositoryHubMarkdownMatches
} from "../../src/tasks/RepositoryGraph";

describe("repository graph", () => {
  it("maps tasks beside one shared repository-hub folder", () => {
    const target = repositoryGraphTarget(
      "Agent Cockpit/Tasks",
      "/Users/example/Documents/GitHub/obsidian-agent/"
    );

    expect(target).toMatchObject({
      repository: "/Users/example/Documents/GitHub/obsidian-agent",
      title: "obsidian-agent",
      folderPath: "Agent Cockpit/Repositories"
    });
    expect(target?.filePath).toMatch(
      /^Agent Cockpit\/Repositories\/obsidian-agent-[a-f0-9]{12}\.md$/
    );
    expect(target?.link).toBe(
      `[[${target?.filePath.slice(0, -3)}|obsidian-agent]]`
    );
  });

  it("keeps same-named repositories distinct while reusing an exact repository", () => {
    const first = repositoryGraphTarget("Tasks", "/work/github/api");
    const repeated = repositoryGraphTarget("Tasks", "/work/github/api/");
    const second = repositoryGraphTarget("Tasks", "/work/gitlab/api");

    expect(repeated).toEqual(first);
    expect(second?.title).toBe(first?.title);
    expect(second?.repositoryId).not.toBe(first?.repositoryId);
    expect(second?.filePath).not.toBe(first?.filePath);
  });

  it("derives a safe sibling folder for root-level and custom task folders", () => {
    expect(repositoryHubFolder("Tasks")).toBe("Repositories");
    expect(repositoryHubFolder("Projects/Agent Work/Tasks")).toBe(
      "Projects/Agent Work/Repositories"
    );
    expect(repositoryHubFolder("Repositories")).toBe("Repository Hubs");
  });

  it("normalizes separators without inventing a repository for blank input", () => {
    expect(normalizeRepositoryIdentity(" C:\\work\\repo\\ ")).toBe("C:/work/repo");
    expect(normalizeRepositoryIdentity("  ")).toBeNull();
    expect(normalizeRepositoryIdentity(null)).toBeNull();
  });

  it("creates a verifiable managed repository note", () => {
    const target = repositoryGraphTarget("Agent Cockpit/Tasks", "/work/repo");
    expect(target).not.toBeNull();

    const markdown = createRepositoryHubMarkdown(target!);

    expect(markdown).toContain("cmux-agent-orchestrator: repository");
    expect(markdown).toContain("# repo");
    expect(repositoryHubMarkdownMatches(markdown, target!)).toBe(true);
    expect(repositoryHubMarkdownMatches(markdown.replace("/work/repo", "/work/other"), target!)).toBe(false);
  });
});
