import { describe, expect, it } from "vitest";
import { pathAffectsTaskFolder } from "../../src/tasks/TaskFolderEvents";

describe("pathAffectsTaskFolder", () => {
  const taskFolder = "Agent Cockpit/Tasks";

  it.each([
    "Agent Cockpit/Tasks",
    "Agent Cockpit/Tasks/task.md",
    "Agent Cockpit/Tasks/Nested/task.md",
    "Agent Cockpit"
  ])("detects task-tree and ancestor changes at %s", (path) => {
    expect(pathAffectsTaskFolder(path, taskFolder)).toBe(true);
  });

  it.each([
    "Agent Cockpit/Tasks archive/task.md",
    "Another Folder/Tasks/task.md",
    "Agent Cockpit.md",
    ""
  ])("ignores unrelated vault changes at %s", (path) => {
    expect(pathAffectsTaskFolder(path, taskFolder)).toBe(false);
  });

  it("normalizes separators before comparing paths", () => {
    expect(pathAffectsTaskFolder("Agent Cockpit\\Tasks\\task.md", taskFolder)).toBe(true);
  });
});
