import { TFile, TFolder, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { TaskRepository } from "../../src/tasks/TaskRepository";
import { createMemoryTaskApp } from "../helpers/memoryTaskApp";

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

  it("serializes concurrent deterministic task creation", async () => {
    let markCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const memory = createMemoryTaskApp({
      beforeCreate: async () => {
        markCreateStarted();
        await createGate;
      }
    });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const options = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Codex run · repository",
      repository: "/repository"
    };

    const firstPromise = repository.ensure(options);
    await createStarted;
    const secondPromise = repository.ensure(options);
    releaseCreate();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.taskId).toBe(first.task.taskId);
    expect(memory.markdownWrites).toHaveLength(1);
    expect(memory.createdPaths).toHaveLength(1);
  });

  it("accepts a failed create only when exact Markdown read-back proves the task exists", async () => {
    const memory = createMemoryTaskApp({ failCreatesAfterMutation: 1 });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const options = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Codex run · repository",
      repository: "/repository"
    };

    const first = await repository.ensure(options);
    const second = await repository.ensure(options);

    expect(first).toMatchObject({ created: true, task: { taskId: options.taskId } });
    expect(second).toMatchObject({ created: false, task: { taskId: options.taskId } });
    expect(memory.markdownWrites).toHaveLength(1);
    expect(memory.createdPaths).toHaveLength(1);
  });

  it("preserves the create error when the occupied path does not contain the intended task", async () => {
    const entries = new Map<string, TFile | TFolder>();
    const root = folder("Agent Cockpit/Tasks", []);
    entries.set(root.path, root);
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
        createFolder: async () => undefined,
        create: async (path: string) => {
          const occupied = file(path);
          entries.set(path, occupied);
          root.children.push(occupied);
          throw new Error("simulated ambiguous create failure");
        },
        read: async () => "# Unrelated user note\n"
      },
      metadataCache: {
        getFileCache: () => null
      }
    } as unknown as App;
    const repository = new TaskRepository(app, root.path);

    await expect(repository.create({ title: "Do not adopt this file" })).rejects.toThrow(
      "simulated ambiguous create failure"
    );
    expect(repository.list()).toEqual([]);
  });

  it("continues processing mutations after an earlier write fails", async () => {
    const memory = createMemoryTaskApp({ failFrontmatterWrites: 1 });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const task = await repository.create({ title: "Recoverable task write" });

    await expect(repository.updateWorkflow(task, "review")).rejects.toThrow(
      "simulated task frontmatter write failure"
    );
    await expect(repository.incrementRunCount(task)).resolves.toBe(1);

    expect(memory.frontmatterWriteAttempts()).toBe(2);
    expect(repository.findById(task.taskId).runCount).toBe(1);
  });

  it("drops write-through task state when a vault event invalidates its path", async () => {
    const memory = createMemoryTaskApp();
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const task = await repository.create({ title: "No longer managed" });

    memory.replaceFrontmatter(task.file.path, {});
    expect(repository.list()).toMatchObject([{ taskId: task.taskId }]);

    repository.invalidatePaths(["Agent Cockpit/Tasks"]);

    expect(repository.list()).toEqual([]);
  });

  it("does not let recent write-through state mask a changed task identity at the same path", async () => {
    const memory = createMemoryTaskApp();
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const task = await repository.create({ title: "Identity changed manually" });
    const replacementTaskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    memory.replaceFrontmatter(task.file.path, {
      "agent-cockpit": "task",
      "schema-version": 1,
      "task-id": replacementTaskId,
      title: "Replacement identity",
      "workflow-status": "active",
      priority: "normal",
      "run-count": 0
    });

    expect(repository.list()).toMatchObject([
      { taskId: replacementTaskId, title: "Replacement identity" }
    ]);
    expect(() => repository.findById(task.taskId)).toThrow("The linked task no longer exists.");
  });

  it("keeps a successful write authoritative until Obsidian invalidates its stale index", async () => {
    const taskFile = file("Agent Cockpit/Tasks/task.md");
    const root = folder("Agent Cockpit/Tasks", [taskFile]);
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const indexedFrontmatter: Record<string, unknown> = {
      "agent-cockpit": "task",
      "schema-version": 1,
      "task-id": taskId,
      title: "Cached task",
      "workflow-status": "active",
      "run-count": 0
    };
    const writableFrontmatter = { ...indexedFrontmatter };
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) =>
          path === root.path ? root : path === taskFile.path ? taskFile : null
      },
      metadataCache: {
        getFileCache: () => ({ frontmatter: indexedFrontmatter })
      },
      fileManager: {
        processFrontMatter: async (
          _file: TFile,
          update: (frontmatter: Record<string, unknown>) => void
        ) => update(writableFrontmatter)
      }
    } as unknown as App;
    const repository = new TaskRepository(app, root.path);
    const task = repository.findById(taskId);

    await repository.updateWorkflow(task, "review");

    expect(indexedFrontmatter["workflow-status"]).toBe("active");
    expect(writableFrontmatter["workflow-status"]).toBe("review");
    expect(repository.list()[0]?.workflowStatus).toBe("review");
    expect(repository.findById(taskId).workflowStatus).toBe("review");

    repository.invalidatePaths([taskFile.path]);
    expect(repository.list()[0]?.workflowStatus).toBe("active");
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

    expect(repository.list()).toEqual([]);
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

  it("does not overwrite a newer workflow decision from a stale task card", async () => {
    const taskFile = file("Agent Cockpit/Tasks/task.md");
    const root = folder("Agent Cockpit/Tasks", [taskFile]);
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const frontmatter: Record<string, unknown> = {
      "agent-cockpit": "task",
      "schema-version": 1,
      "task-id": taskId,
      title: "Concurrent workflow task",
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
    const staleTask = repository.findById(taskId);

    await repository.updateWorkflow(staleTask, "review");
    await expect(repository.updateWorkflow(staleTask, "done")).rejects.toThrow(
      /workflow changed before the update/
    );

    expect(frontmatter["workflow-status"]).toBe("review");
  });
});
