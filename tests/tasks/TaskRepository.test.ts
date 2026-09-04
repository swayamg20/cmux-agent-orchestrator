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

  it("creates a deterministic task once and reuses it after the vault index catches up", async () => {
    const entries = new Map<string, TFile | TFolder>();
    const frontmatter = new Map<TFile, Record<string, unknown>>();
    const writes: string[] = [];
    const createFolder = async (path: string): Promise<void> => {
      const created = folder(path, []);
      entries.set(path, created);
      const parentPath = path.split("/").slice(0, -1).join("/");
      const parent = entries.get(parentPath);
      if (parent instanceof TFolder) parent.children.push(created);
    };
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
        createFolder,
        create: async (path: string, markdown: string) => {
          writes.push(markdown);
          const created = file(path);
          entries.set(path, created);
          const parent = entries.get(path.split("/").slice(0, -1).join("/"));
          if (parent instanceof TFolder) parent.children.push(created);
          frontmatter.set(created, {
            "agent-cockpit": "task",
            "schema-version": 1,
            "task-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            title: "Codex run · repository",
            "workflow-status": "active",
            priority: "normal",
            repository: "/repository",
            "run-count": 0,
            "created-at": "2026-09-04T00:00:00.000Z",
            "updated-at": "2026-09-04T00:00:00.000Z"
          });
          return created;
        }
      },
      metadataCache: {
        getFileCache: (candidate: TFile) => ({ frontmatter: frontmatter.get(candidate) })
      }
    } as unknown as App;
    const repository = new TaskRepository(app, "Agent Cockpit/Tasks");
    const options = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Codex run · repository",
      repository: "/repository"
    };

    const first = await repository.ensure(options);
    const second = await repository.ensure(options);

    expect(first).toMatchObject({ created: true, task: { taskId: options.taskId } });
    expect(second).toMatchObject({ created: false, task: { taskId: options.taskId } });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(`task-id: "${options.taskId}"`);

    repository.setTaskFolder("Different Tasks");
    expect(repository.list()).toEqual([]);
  });

  it("fails closed when two Markdown notes claim the same task ID", async () => {
    const first = file("Agent Cockpit/Tasks/first.md");
    const second = file("Agent Cockpit/Tasks/second.md");
    const root = folder("Agent Cockpit/Tasks", [first, second]);
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) => (path === root.path ? root : null)
      },
      metadataCache: {
        getFileCache: (candidate: TFile) => ({
          frontmatter: {
            "agent-cockpit": "task",
            "schema-version": 1,
            "task-id": taskId,
            title: candidate.basename,
            "workflow-status": "active"
          }
        })
      }
    } as unknown as App;
    const repository = new TaskRepository(app, root.path);

    expect(() => repository.findById(taskId)).toThrow("The task ID is duplicated in the vault.");
    await expect(
      repository.ensure({ taskId, title: "Codex run · repository", repository: "/repository" })
    ).rejects.toThrow("The automatic task ID is duplicated in the vault.");
  });

  it("reuses and safely updates a task whose frontmatter UUID uses uppercase", async () => {
    const taskFile = file("Agent Cockpit/Tasks/task.md");
    const root = folder("Agent Cockpit/Tasks", [taskFile]);
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const frontmatter: Record<string, unknown> = {
      "agent-cockpit": "task",
      "schema-version": 1,
      "task-id": taskId.toUpperCase(),
      title: "Existing task",
      "workflow-status": "active"
    };
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) =>
          path === root.path ? root : path === taskFile.path ? taskFile : null
      },
      metadataCache: {
        getFileCache: () => ({ frontmatter })
      },
      fileManager: {
        processFrontMatter: async (
          _file: TFile,
          update: (value: Record<string, unknown>) => void
        ) => update(frontmatter)
      }
    } as unknown as App;
    const repository = new TaskRepository(app, root.path);

    const ensured = await repository.ensure({ taskId, title: "Should not be created" });
    await repository.updateWorkflow(ensured.task, "review");

    expect(ensured).toMatchObject({ created: false, task: { taskId } });
    expect(frontmatter["workflow-status"]).toBe("review");
  });
});
