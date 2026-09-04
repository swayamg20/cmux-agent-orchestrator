import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesheet.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (match?.[1] === undefined) throw new Error(`Missing CSS rule for ${selector}.`);
  return match[1].replace(/\s+/g, " ").trim();
}

describe("Work board viewport layout", () => {
  it("keeps the plugin shell inside the Obsidian view instead of scrolling the whole page", () => {
    expect(
      declarationsFor(".workspace-leaf-content .view-content.agent-cockpit-view-content")
    ).toContain("overflow: hidden");
    expect(declarationsFor(".agent-cockpit")).toContain("display: flex");
    expect(declarationsFor(".agent-cockpit")).toContain("height: 100%");
    expect(declarationsFor(".agent-cockpit-panel-slot")).toContain("min-height: 0");
    expect(declarationsFor(".agent-cockpit-panel-slot")).toContain("overflow: hidden");
  });

  it("gives each workflow column its own vertical scroller", () => {
    expect(declarationsFor(".agent-cockpit-mode-panel--work")).toContain("overflow: hidden");
    expect(declarationsFor(".agent-cockpit-kanban-panel")).toContain("display: flex");
    expect(declarationsFor(".agent-cockpit-kanban-board")).toContain("overflow-y: hidden");
    expect(declarationsFor(".agent-cockpit-kanban-column")).toContain("display: flex");
    expect(declarationsFor(".agent-cockpit-kanban-task-list")).toContain("overflow-y: auto");
  });
});
