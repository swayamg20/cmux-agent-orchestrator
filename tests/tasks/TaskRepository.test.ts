import { TFile, TFolder, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { TaskRepository } from "../../src/tasks/TaskRepository";

function file(path: string, extension = "md"): TFile {
  const name = path.split("/").pop() ?? path;
  return Object.assign(new TFile(), {
    path,
    extension,
    basename: name.replace(/\.[^.]+$/, ""),
    stat: { ctime: 1, mtime: 2 }
  });
}

function folder(path: string, children: Array<TFile | TFolder>): TFolder {
  return Object.assign(new TFolder(), { path, children });
}

describe("TaskRepository", () => {
  it("discovers Markdown tasks only inside the configured task folder", () => {
    const task = file("Agent Cockpit/Tasks/nested/task.md");
    const nonMarkdown = file("Agent Cockpit/Tasks/ignored.txt", "txt");
    const root = folder("Agent Cockpit/Tasks", [folder("Agent Cockpit/Tasks/nested", [task]), nonMarkdown]);
    const getMarkdownFiles = vi.fn(() => {
      throw new Error("vault-wide enumeration must not be used");
    });
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) => (path === "Agent Cockpit/Tasks" ? root : null),
        getMarkdownFiles
      },
      metadataCache: {
        getFileCache: (candidate: TFile) =>
          candidate === task
            ? {
                frontmatter: {
                  "agent-cockpit": "task",
                  "schema-version": 1,
                  "task-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                  title: "Scoped task",
                  "workflow-status": "active"
                }
              }
            : null
      }
    } as unknown as App;

    const tasks = new TaskRepository(app, "Agent Cockpit/Tasks").list();

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Scoped task", workflowStatus: "active" });
    expect(getMarkdownFiles).not.toHaveBeenCalled();
  });
});
