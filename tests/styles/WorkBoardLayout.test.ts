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
  it("keeps both plugin surfaces inside their Obsidian views", () => {
    expect(
      declarationsFor(
        ".workspace-leaf-content .view-content.agent-cockpit-view-content,\n.workspace-leaf-content .view-content.agent-cockpit-board-view-content"
      )
    ).toContain("overflow: hidden");
    expect(declarationsFor(".agent-cockpit")).toContain("display: flex");
    expect(declarationsFor(".agent-cockpit")).toContain("height: 100%");
    expect(declarationsFor(".agent-cockpit-panel-slot")).toContain("min-height: 0");
    expect(declarationsFor(".agent-cockpit-panel-slot")).toContain("overflow: hidden");
  });

  it("keeps the overview scrollable and gives the dedicated board bounded scrollers", () => {
    expect(declarationsFor(".agent-cockpit-mode-panel--work")).toContain("overflow-y: auto");
    expect(declarationsFor(".agent-cockpit-board-host")).toContain("overflow: hidden");
    expect(declarationsFor(".agent-cockpit-board-host")).toContain("min-height: 0");
    expect(declarationsFor(".agent-cockpit-kanban-board")).toContain("overflow-y: hidden");
    expect(declarationsFor(".agent-cockpit-kanban-board")).toContain("overflow-x: auto");
    expect(declarationsFor(".agent-cockpit-kanban-board")).toContain("width: 100%");
    expect(declarationsFor(".agent-cockpit-kanban-board")).toContain("min-width: 0");
    expect(declarationsFor(".agent-cockpit-kanban-column")).toContain("display: flex");
    expect(declarationsFor(".agent-cockpit-kanban-task-list")).toContain("overflow-y: auto");
  });

  it("does not let the Work panel occupy space while another tab is selected", () => {
    expect(declarationsFor(".agent-cockpit-mode-panel[hidden]")).toContain("display: none");
  });

  it("provides explicit themed hover feedback for task and row actions", () => {
    expect(declarationsFor(".agent-cockpit-task-title:hover")).toContain(
      "background: var(--background-modifier-hover)"
    );
    expect(
      declarationsFor(".agent-cockpit .agent-cockpit-action:not(.mod-cta):hover")
    ).toContain("background: var(--background-modifier-hover)");
  });

  it("keeps workflow suggestions horizontal without exposing card prose", () => {
    expect(declarationsFor(".agent-cockpit-workflow-suggestion")).toContain("display: flex");
    expect(declarationsFor(".agent-cockpit-workflow-suggestion")).toContain("flex-wrap: wrap");
    expect(declarationsFor(".agent-cockpit-workflow-suggestion-detail")).toContain(
      "text-overflow: ellipsis"
    );
  });

  it("does not replay an entrance animation whenever an expanded session refreshes", () => {
    expect(declarationsFor(".agent-cockpit-session-body")).not.toContain("animation:");
  });
});
