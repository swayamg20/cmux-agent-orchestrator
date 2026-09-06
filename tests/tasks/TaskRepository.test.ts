import { TFile, TFolder, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { TaskRepository } from "../../src/tasks/TaskRepository";
import { createTaskMarkdown } from "../../src/tasks/TaskTemplate";
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

function taskMarkdown(taskId: string, title = "Codex run · repository"): string {
  return createTaskMarkdown({
    taskId,
    title,
    workflowStatus: "active",
    priority: "normal",
    repository: "/repository",
    branch: null,
    worktree: null,
    now: "2026-09-04T00:00:00.000Z"
  });
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
    const markdownByFile = new Map<TFile, string>();
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
          markdownByFile.set(created, markdown);
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
        },
        read: async (candidate: TFile) => markdownByFile.get(candidate) ?? ""
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

  it("serializes deterministic creation across repository replacements before metadata catches up", async () => {
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
      },
      metadataVisible: () => false
    });
    const firstRepository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const replacementRepository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const options = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Codex run · repository",
      repository: "/repository"
    };

    const firstPromise = firstRepository.ensure(options);
    await createStarted;
    const replacementPromise = replacementRepository.ensure(options);
    releaseCreate();
    const [first, replacement] = await Promise.all([firstPromise, replacementPromise]);

    expect(first).toMatchObject({ created: true, task: { taskId: options.taskId } });
    expect(replacement).toMatchObject({ created: false, task: { taskId: options.taskId } });
    expect(memory.markdownWrites).toHaveLength(1);
    expect(memory.createdPaths).toEqual(["Agent Cockpit/Tasks/codex-run-repository.md"]);
  });

  it("does not report success when a concurrent vault writer creates the same task ID", async () => {
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let injectDuplicate = true;
    let memory!: ReturnType<typeof createMemoryTaskApp>;
    memory = createMemoryTaskApp({
      afterCreateMutation: async () => {
        if (!injectDuplicate) return;
        injectDuplicate = false;
        await memory.app.vault.create(
          "Agent Cockpit/Tasks/racing-duplicate.md",
          taskMarkdown(taskId, "Racing duplicate")
        );
      }
    });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");

    await expect(repository.ensure({
      taskId,
      title: "Codex run · repository",
      repository: "/repository"
    })).rejects.toThrow("automatic task ID is duplicated");
    expect(memory.markdownWrites).toHaveLength(2);
    expect(repository.list()).toEqual([]);
  });

  it("does not trust a task write invalidated during post-create verification", async () => {
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const taskPath = "Agent Cockpit/Tasks/codex-run-repository.md";
    const memory = createMemoryTaskApp();
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const readMarkdown = memory.app.vault.read.bind(memory.app.vault);
    let invalidated = false;
    vi.spyOn(memory.app.vault, "read").mockImplementation(async (file) => {
      const markdown = await readMarkdown(file);
      if (!invalidated && file.path === taskPath) {
        invalidated = true;
        memory.replaceMarkdown(taskPath, "# User replaced this task\n");
        memory.replaceFrontmatter(taskPath, {});
        repository.invalidateVaultEvents([{ file, path: file.path }], []);
      }
      return markdown;
    });

    await expect(repository.ensure({
      taskId,
      title: "Codex run · repository",
      repository: "/repository"
    })).rejects.toThrow("Task notes changed during verification");
    expect(memory.markdownWrites).toHaveLength(1);
    expect(repository.list()).toEqual([]);
    expect(() => repository.findById(taskId)).toThrow("The linked task no longer exists.");
  });

  it("does not report success when the created task disappears before post-create verification", async () => {
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const taskPath = "Agent Cockpit/Tasks/codex-run-repository.md";
    const memory = createMemoryTaskApp({ removeAfterCreate: true });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");

    await expect(repository.ensure({
      taskId,
      title: "Codex run · repository",
      repository: "/repository"
    })).rejects.toThrow("could not be verified safely");
    expect(memory.createdPaths).toEqual([taskPath]);
    expect(memory.app.vault.getAbstractFileByPath(taskPath)).toBeNull();
    expect(repository.list()).toEqual([]);
  });

  it("does not restore stale write-through state after leaving and returning to a task folder", async () => {
    const memory = createMemoryTaskApp();
    const repository = new TaskRepository(memory.app, "Folder A");
    const task = await repository.create({ title: "Task" });

    repository.setTaskFolder("Folder B");
    memory.replaceFrontmatter(task.file.path, {});
    repository.setTaskFolder("Folder A");

    expect(repository.list()).toEqual([]);
    expect(() => repository.findById(task.taskId)).toThrow("The linked task no longer exists.");
  });

  it("preserves an unindexed deterministic task across task-folder navigation", async () => {
    const memory = createMemoryTaskApp({ metadataVisible: () => false });
    const repository = new TaskRepository(memory.app, "Folder A");
    const options = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Codex run · repository",
      repository: "/repository"
    };
    const created = await repository.ensure(options);

    repository.setTaskFolder("Folder B");
    repository.setTaskFolder("Folder A");
    const reused = await repository.ensure(options);

    expect(created).toMatchObject({ created: true });
    expect(reused).toMatchObject({ created: false, task: { taskId: options.taskId } });
    expect(memory.markdownWrites).toHaveLength(1);
    expect(memory.createdPaths).toEqual(["Folder A/codex-run-repository.md"]);
  });

  it("does not reuse known-invalid write-through state after repository replacement", async () => {
    const memory = createMemoryTaskApp();
    const firstRepository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const task = await firstRepository.create({ title: "Task" });
    memory.replaceFrontmatter(task.file.path, {});

    const replacementRepository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");

    expect(replacementRepository.list()).toEqual([]);
    expect(() => replacementRepository.findById(task.taskId)).toThrow(
      "The linked task no longer exists."
    );
  });

  it("drops write-through state when a task file is replaced at the same path", async () => {
    const memory = createMemoryTaskApp();
    const repository = new TaskRepository(memory.app, "Folder A");
    const task = await repository.create({ title: "Task" });

    repository.setTaskFolder("Folder B");
    memory.replaceFile(task.file.path, {});
    repository.setTaskFolder("Folder A");

    expect(repository.list()).toEqual([]);
    expect(() => repository.findById(task.taskId)).toThrow("The linked task no longer exists.");
  });

  it("bridges deterministic task identity across rename before metadata reindexing", async () => {
    const memory = createMemoryTaskApp({ metadataVisible: () => false });
    const repository = new TaskRepository(memory.app, "Folder A");
    const options = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Codex run · repository",
      repository: "/repository"
    };
    const created = await repository.ensure(options);
    const oldPath = created.task.file.path;
    const newPath = "Folder A/renamed-task.md";

    const renamedFile = memory.renameFile(oldPath, newPath);
    repository.invalidateVaultEvents([], [{ file: renamedFile, oldPath }]);
    const reused = await repository.ensure(options);

    expect(created).toMatchObject({ created: true });
    expect(reused).toMatchObject({
      created: false,
      task: { taskId: options.taskId, file: { path: newPath } }
    });
    expect(memory.markdownWrites).toHaveLength(1);
    expect(memory.createdPaths).toEqual([oldPath]);
  });

  it("does not bridge a renamed task that is no longer Markdown", async () => {
    const memory = createMemoryTaskApp({ metadataVisible: () => false });
    const repository = new TaskRepository(memory.app, "Folder A");
    const task = await repository.create({ title: "No longer Markdown" });
    const oldPath = task.file.path;
    const renamedFile = memory.renameFile(oldPath, "Folder A/no-longer-markdown.txt");

    repository.invalidateVaultEvents([], [{ file: renamedFile, oldPath }]);

    expect(repository.list()).toEqual([]);
    expect(() => repository.findById(task.taskId)).toThrow("The linked task no longer exists.");
  });

  it("bridges descendant task identity across a nested-folder rename", async () => {
    const memory = createMemoryTaskApp({ metadataVisible: () => false });
    const repository = new TaskRepository(memory.app, "Folder A");
    const options = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Nested deterministic task",
      repository: "/repository"
    };
    const created = await repository.ensure(options);
    await memory.app.vault.createFolder("Folder A/Nested");
    const originalPath = created.task.file.path;
    const nestedPath = "Folder A/Nested/nested-deterministic-task.md";
    const nestedFile = memory.renameFile(originalPath, nestedPath);
    repository.invalidateVaultEvents([], [{ file: nestedFile, oldPath: originalPath }]);
    const nestedFolder = memory.renameFolder("Folder A/Nested", "Folder A/Renamed");

    repository.invalidateVaultEvents([], [{ file: nestedFolder, oldPath: "Folder A/Nested" }]);
    const reused = await repository.ensure(options);

    expect(reused).toMatchObject({
      created: false,
      task: { taskId: options.taskId, file: { path: "Folder A/Renamed/nested-deterministic-task.md" } }
    });
    expect(memory.markdownWrites).toHaveLength(1);
    expect(memory.createdPaths).toEqual([originalPath]);
  });

  it("preserves each exact identity across an interacting rename batch", async () => {
    const memory = createMemoryTaskApp({ metadataVisible: () => false });
    const repository = new TaskRepository(memory.app, "Folder A");
    const firstOptions = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "First",
      repository: "/repository"
    };
    const secondOptions = {
      taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "Second",
      repository: "/repository"
    };
    const first = await repository.ensure(firstOptions);
    const second = await repository.ensure(secondOptions);
    const firstPath = first.task.file.path;
    const secondPath = second.task.file.path;
    const temporaryPath = "Folder A/temporary.md";
    const firstFile = memory.renameFile(firstPath, temporaryPath);
    const secondFile = memory.renameFile(secondPath, firstPath);
    memory.renameFile(temporaryPath, secondPath);
    const renames = [
      { file: firstFile, oldPath: firstPath },
      { file: secondFile, oldPath: secondPath }
    ];

    repository.invalidateVaultEvents([], renames);
    const reusedFirst = await repository.ensure(firstOptions);
    const reusedSecond = await repository.ensure(secondOptions);

    expect(reusedFirst).toMatchObject({
      created: false,
      task: { taskId: firstOptions.taskId, file: { path: secondPath } }
    });
    expect(reusedSecond).toMatchObject({
      created: false,
      task: { taskId: secondOptions.taskId, file: { path: firstPath } }
    });
    expect(memory.markdownWrites).toHaveLength(2);
  });

  it("does not let a later rename launder an earlier generic change", async () => {
    const memory = createMemoryTaskApp({ metadataVisible: () => false });
    const repository = new TaskRepository(memory.app, "Folder A");
    const task = await repository.create({ title: "Changed then renamed" });
    const oldPath = task.file.path;
    memory.replaceFrontmatter(oldPath, {});
    const invalidation = { file: task.file, path: oldPath };
    const renamedFile = memory.renameFile(oldPath, "Folder A/renamed-after-change.md");

    repository.invalidateVaultEvents([invalidation], [{ file: renamedFile, oldPath }]);

    expect(repository.list()).toEqual([]);
    expect(() => repository.findById(task.taskId)).toThrow("The linked task no longer exists.");
  });

  it("does not apply old-path evidence to a different replacement file", async () => {
    const memory = createMemoryTaskApp({ metadataVisible: () => false });
    const repository = new TaskRepository(memory.app, "Folder A");
    const changed = await repository.create({ title: "Reusable path" });
    const oldPath = changed.file.path;
    const invalidation = { file: changed.file, path: oldPath };
    const renamedFile = memory.renameFile(oldPath, "Folder A/changed-and-renamed.md");
    const replacement = await repository.create({ title: "Reusable path" });

    repository.invalidateVaultEvents([invalidation], [{ file: renamedFile, oldPath }]);

    expect(() => repository.findById(changed.taskId)).toThrow("The linked task no longer exists.");
    expect(repository.findById(replacement.taskId).file).toBe(replacement.file);
    expect(repository.list()).toMatchObject([{ taskId: replacement.taskId }]);
    expect(memory.markdownWrites).toHaveLength(2);
  });

  it("cancels guarded deterministic creation before queued vault work starts", async () => {
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
    const firstPromise = repository.ensure({
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "First Codex run",
      repository: "/repository"
    });
    await createStarted;

    let allowed = true;
    const cancelledPromise = repository.ensure(
      {
        taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        title: "Cancelled Codex run",
        repository: "/repository"
      },
      () => allowed
    );
    allowed = false;
    releaseCreate();

    await expect(firstPromise).resolves.toMatchObject({ created: true });
    await expect(cancelledPromise).resolves.toBeNull();
    expect(memory.markdownWrites).toHaveLength(1);
    expect(memory.createdPaths).toEqual(["Agent Cockpit/Tasks/first-codex-run.md"]);
  });

  it("stops creating a nested task folder when guarded creation is cancelled", async () => {
    let markRootFolderStarted!: () => void;
    const rootFolderStarted = new Promise<void>((resolve) => {
      markRootFolderStarted = resolve;
    });
    let releaseRootFolder!: () => void;
    const rootFolderGate = new Promise<void>((resolve) => {
      releaseRootFolder = resolve;
    });
    const memory = createMemoryTaskApp({
      beforeCreateFolder: async (path) => {
        if (path !== "Agent Cockpit") return;
        markRootFolderStarted();
        await rootFolderGate;
      }
    });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    let allowed = true;

    const creation = repository.ensure(
      {
        taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        title: "Cancelled Codex run",
        repository: "/repository"
      },
      () => allowed
    );
    await rootFolderStarted;
    allowed = false;
    releaseRootFolder();

    await expect(creation).resolves.toBeNull();
    expect(memory.createdFolderPaths).toEqual(["Agent Cockpit"]);
    expect(memory.createdPaths).toEqual([]);
  });

  it("cancels a queued guarded run-count repair before frontmatter changes", async () => {
    let blockCreate = false;
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
        if (!blockCreate) return;
        markCreateStarted();
        await createGate;
      }
    });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const task = await repository.create({ title: "Existing automatic task" });

    blockCreate = true;
    const blockingCreate = repository.create({ title: "Blocking task" });
    await createStarted;
    let allowed = true;
    const repair = repository.ensureRunCountAtLeast(task, 1, () => allowed);
    allowed = false;
    releaseCreate();

    await blockingCreate;
    await expect(repair).resolves.toBeNull();
    expect(memory.frontmatterWriteAttempts()).toBe(0);
    expect(repository.findById(task.taskId).runCount).toBe(0);
  });

  it("rechecks guarded run-count authority inside the frontmatter mutation", async () => {
    let markFrontmatterStarted!: () => void;
    const frontmatterStarted = new Promise<void>((resolve) => {
      markFrontmatterStarted = resolve;
    });
    let releaseFrontmatter!: () => void;
    const frontmatterGate = new Promise<void>((resolve) => {
      releaseFrontmatter = resolve;
    });
    const memory = createMemoryTaskApp({
      beforeFrontmatter: async () => {
        markFrontmatterStarted();
        await frontmatterGate;
      }
    });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const task = await repository.create({ title: "Guard callback task" });
    let allowed = true;

    const repair = repository.ensureRunCountAtLeast(task, 1, () => allowed);
    await frontmatterStarted;
    allowed = false;
    releaseFrontmatter();

    await expect(repair).resolves.toBeNull();
    expect(memory.frontmatterWriteAttempts()).toBe(1);
    expect(repository.findById(task.taskId).runCount).toBe(0);
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

  it("does not duplicate a deterministic task after an uncertain post-create failure", async () => {
    let metadataVisible = false;
    const memory = createMemoryTaskApp({
      failCreatesAfterMutation: 1,
      metadataVisible: () => metadataVisible
    });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const options = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Codex run · repository",
      repository: "/repository"
    };
    vi.spyOn(memory.app.vault, "read").mockRejectedValueOnce(
      new Error("simulated transient task read failure")
    );

    await expect(repository.ensure(options)).rejects.toThrow(
      "simulated post-create vault failure"
    );
    expect(memory.markdownWrites).toHaveLength(1);

    const recovered = await repository.ensure(options);

    expect(memory.markdownWrites).toHaveLength(1);
    expect(memory.createdPaths).toHaveLength(1);
    expect(recovered).toMatchObject({ created: false, task: { taskId: options.taskId } });

    metadataVisible = true;
    expect(repository.list()).toMatchObject([{ taskId: options.taskId }]);
  });

  it("retains uncertain task evidence when recovery is invalidated during its read", async () => {
    let metadataVisible = false;
    const memory = createMemoryTaskApp({
      failCreatesAfterMutation: 1,
      metadataVisible: () => metadataVisible
    });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const taskPath = "Agent Cockpit/Tasks/codex-run-repository.md";
    const options = {
      taskId,
      title: "Codex run · repository",
      repository: "/repository"
    };
    const readMarkdown = memory.app.vault.read.bind(memory.app.vault);
    let readAttempts = 0;
    vi.spyOn(memory.app.vault, "read").mockImplementation(async (file) => {
      readAttempts += 1;
      if (readAttempts === 1) throw new Error("simulated transient task read failure");
      const markdown = await readMarkdown(file);
      if (readAttempts === 2) {
        memory.replaceMarkdown(taskPath, "# User replaced this task\n");
        memory.replaceFrontmatter(taskPath, {});
        metadataVisible = true;
        repository.invalidateVaultEvents([{ file, path: file.path }], []);
      }
      return markdown;
    });

    await expect(repository.ensure(options)).rejects.toThrow(
      "simulated post-create vault failure"
    );
    await expect(repository.ensure(options)).rejects.toThrow(
      "Task notes changed during verification"
    );
    expect(memory.markdownWrites).toHaveLength(1);
    expect(repository.list()).toEqual([]);
    expect(() => repository.findById(taskId)).toThrow("The linked task no longer exists.");

    await expect(repository.ensure(options)).resolves.toMatchObject({
      created: true,
      task: { taskId, file: { path: "Agent Cockpit/Tasks/codex-run-repository-2.md" } }
    });
    expect(memory.markdownWrites).toHaveLength(2);
  });

  it("keeps an unreadable uncertain task write fail-closed until it can be verified", async () => {
    const memory = createMemoryTaskApp({
      failCreatesAfterMutation: 1,
      metadataVisible: () => false
    });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const options = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Codex run · repository",
      repository: "/repository"
    };
    const read = vi.spyOn(memory.app.vault, "read");
    read.mockRejectedValueOnce(new Error("simulated first task read failure"));

    await expect(repository.ensure(options)).rejects.toThrow(
      "simulated post-create vault failure"
    );
    read.mockRejectedValueOnce(new Error("simulated retry task read failure"));

    await expect(repository.ensure(options)).rejects.toThrow(
      "could not be verified safely"
    );
    expect(memory.markdownWrites).toHaveLength(1);
    expect(memory.createdPaths).toHaveLength(1);

    await expect(repository.ensure(options)).resolves.toMatchObject({
      created: false,
      task: { taskId: options.taskId }
    });
    expect(memory.markdownWrites).toHaveLength(1);
  });

  it("recovers an uncertain deterministic create across repository replacement", async () => {
    const memory = createMemoryTaskApp({
      failCreatesAfterMutation: 1,
      metadataVisible: () => false
    });
    const options = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Codex run · repository",
      repository: "/repository"
    };
    vi.spyOn(memory.app.vault, "read").mockRejectedValueOnce(
      new Error("simulated transient task read failure")
    );

    await expect(
      new TaskRepository(memory.app, "Agent Cockpit/Tasks").ensure(options)
    ).rejects.toThrow("simulated post-create vault failure");

    const replacement = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    await expect(replacement.ensure(options)).resolves.toMatchObject({
      created: false,
      task: { taskId: options.taskId }
    });
    expect(memory.createdPaths).toEqual(["Agent Cockpit/Tasks/codex-run-repository.md"]);
  });

  it("does not duplicate an unresolved task while a different task folder is selected", async () => {
    const memory = createMemoryTaskApp({
      failCreatesAfterMutation: 1,
      metadataVisible: () => false
    });
    const repository = new TaskRepository(memory.app, "Folder A");
    const options = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Codex run · repository",
      repository: "/repository"
    };
    vi.spyOn(memory.app.vault, "read").mockRejectedValueOnce(
      new Error("simulated transient task read failure")
    );
    await expect(repository.ensure(options)).rejects.toThrow(
      "simulated post-create vault failure"
    );

    repository.setTaskFolder("Folder B");
    await expect(repository.ensure(options)).rejects.toThrow(
      "could not be verified safely"
    );
    expect(memory.markdownWrites).toHaveLength(1);

    repository.setTaskFolder("Folder A");
    await expect(repository.ensure(options)).resolves.toMatchObject({
      created: false,
      task: { taskId: options.taskId }
    });
    expect(memory.markdownWrites).toHaveLength(1);
  });

  it("releases a cross-folder pending claim after its Markdown proves a different identity", async () => {
    const memory = createMemoryTaskApp({
      failCreatesAfterMutation: 1,
      metadataVisible: () => false
    });
    const repository = new TaskRepository(memory.app, "Folder A");
    const options = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Codex run · repository",
      repository: "/repository"
    };
    vi.spyOn(memory.app.vault, "read").mockRejectedValueOnce(
      new Error("simulated transient task read failure")
    );
    await expect(repository.ensure(options)).rejects.toThrow(
      "simulated post-create vault failure"
    );
    const oldPath = memory.createdPaths[0]!;
    repository.setTaskFolder("Folder B");
    expect(repository.observesVaultPath(oldPath)).toBe(true);
    expect(repository.observesVaultPath("Folder B/new-task.md")).toBe(true);
    expect(repository.observesVaultPath("Unrelated/note.md")).toBe(false);
    memory.replaceMarkdown(
      oldPath,
      taskMarkdown("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Different task")
    );

    const replacement = new TaskRepository(memory.app, "Folder B");
    await expect(replacement.ensure(options)).resolves.toMatchObject({
      created: true,
      task: { taskId: options.taskId, file: { path: "Folder B/codex-run-repository.md" } }
    });
    expect(replacement.observesVaultPath(oldPath)).toBe(false);
    expect(memory.markdownWrites).toHaveLength(2);
  });

  it("does not suffix-create over an unindexed deterministic task after restart", async () => {
    let metadataVisible = false;
    const memory = createMemoryTaskApp({ metadataVisible: () => metadataVisible });
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await memory.app.vault.createFolder("Agent Cockpit");
    await memory.app.vault.createFolder("Agent Cockpit/Tasks");
    await memory.app.vault.create(
      "Agent Cockpit/Tasks/codex-run-repository.md",
      taskMarkdown(taskId).replace(/\n/g, "\r\n")
    );
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");

    await expect(repository.ensure({
      taskId,
      title: "Codex run · repository",
      repository: "/repository"
    })).rejects.toThrow("has not indexed it yet");
    expect(memory.markdownWrites).toHaveLength(1);

    metadataVisible = true;
    await expect(repository.ensure({
      taskId,
      title: "Codex run · repository",
      repository: "/repository"
    })).resolves.toMatchObject({ created: false, task: { taskId } });
    expect(memory.markdownWrites).toHaveLength(1);
  });

  it("does not reuse one indexed match while a second same-ID note is unindexed", async () => {
    const hiddenPath = "Agent Cockpit/Tasks/hidden-copy.md";
    const memory = createMemoryTaskApp({
      metadataVisible: (file) => file.path !== hiddenPath
    });
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await memory.app.vault.createFolder("Agent Cockpit");
    await memory.app.vault.createFolder("Agent Cockpit/Tasks");
    await memory.app.vault.create(
      "Agent Cockpit/Tasks/indexed-copy.md",
      taskMarkdown(taskId, "Indexed copy")
    );
    await memory.app.vault.create(hiddenPath, taskMarkdown(taskId, "Hidden copy"));
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");

    await expect(repository.ensure({
      taskId,
      title: "Codex run · repository",
      repository: "/repository"
    })).rejects.toThrow(/duplicated|has not indexed/);
    expect(memory.markdownWrites).toHaveLength(2);
  });

  it("does not duplicate a same-ID note whose metadata cache is present but stale", async () => {
    const memory = createMemoryTaskApp();
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const stalePath = "Agent Cockpit/Tasks/old-title.md";
    await memory.app.vault.createFolder("Agent Cockpit");
    await memory.app.vault.createFolder("Agent Cockpit/Tasks");
    await memory.app.vault.create(stalePath, taskMarkdown(taskId, "Old title"));
    memory.replaceFrontmatter(stalePath, {});
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");

    await expect(repository.ensure({
      taskId,
      title: "Codex run · repository",
      repository: "/repository"
    })).rejects.toThrow("has not indexed it yet");
    expect(memory.markdownWrites).toHaveLength(1);
  });

  it("does not trust a valid cached task identity when the Markdown identity changed", async () => {
    const memory = createMemoryTaskApp();
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const cachedTaskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const stalePath = "Agent Cockpit/Tasks/stale-valid-cache.md";
    await memory.app.vault.createFolder("Agent Cockpit");
    await memory.app.vault.createFolder("Agent Cockpit/Tasks");
    await memory.app.vault.create(
      stalePath,
      taskMarkdown(cachedTaskId, "Cached identity")
    );
    memory.replaceMarkdown(stalePath, taskMarkdown(taskId, "Current identity"));
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");

    await expect(repository.ensure({
      taskId,
      title: "Codex run · repository",
      repository: "/repository"
    })).rejects.toThrow("could not be verified safely");
    expect(memory.markdownWrites).toHaveLength(1);
  });

  it("recognizes valid quoted YAML keys when checking an unindexed task identity", async () => {
    const memory = createMemoryTaskApp({ metadataVisible: () => false });
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const quotedPath = "Agent Cockpit/Tasks/old-title.md";
    await memory.app.vault.createFolder("Agent Cockpit");
    await memory.app.vault.createFolder("Agent Cockpit/Tasks");
    await memory.app.vault.create(quotedPath, taskMarkdown(taskId, "Old title"));
    memory.replaceMarkdown(
      quotedPath,
      taskMarkdown(taskId, "Old title")
        .replace(/^agent-cockpit:/m, '"agent-cockpit":')
        .replace(/^task-id:/m, '"task-id":')
    );
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");

    await expect(repository.ensure({
      taskId,
      title: "Codex run · repository",
      repository: "/repository"
    })).rejects.toThrow("has not indexed it yet");
    expect(memory.markdownWrites).toHaveLength(1);
  });

  it("fails closed when raw task frontmatter repeats an identity key", async () => {
    const memory = createMemoryTaskApp({ metadataVisible: () => false });
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ambiguousPath = "Agent Cockpit/Tasks/ambiguous.md";
    await memory.app.vault.createFolder("Agent Cockpit");
    await memory.app.vault.createFolder("Agent Cockpit/Tasks");
    await memory.app.vault.create(ambiguousPath, taskMarkdown(taskId, "Ambiguous"));
    memory.replaceMarkdown(
      ambiguousPath,
      taskMarkdown(taskId, "Ambiguous").replace(
        /^task-id:.*$/m,
        `task-id: "${taskId}"\n"task-id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"`
      )
    );
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");

    await expect(repository.ensure({
      taskId,
      title: "Codex run · repository",
      repository: "/repository"
    })).rejects.toThrow("could not be verified safely");
    expect(memory.markdownWrites).toHaveLength(1);
  });

  it("recovers an uncertain pending create after a same-folder Markdown rename", async () => {
    const memory = createMemoryTaskApp({
      failCreatesAfterMutation: 1,
      metadataVisible: () => false
    });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const options = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Codex run · repository",
      repository: "/repository"
    };
    vi.spyOn(memory.app.vault, "read").mockRejectedValueOnce(
      new Error("simulated transient task read failure")
    );
    await expect(repository.ensure(options)).rejects.toThrow(
      "simulated post-create vault failure"
    );
    const originalPath = memory.createdPaths[0]!;
    const renamedPath = "Agent Cockpit/Tasks/renamed-pending.md";
    const renamed = memory.renameFile(originalPath, renamedPath);

    repository.invalidateVaultEvents([], [{ file: renamed, oldPath: originalPath }]);

    await expect(repository.ensure(options)).resolves.toMatchObject({
      created: false,
      task: { taskId: options.taskId, file: { path: renamedPath } }
    });
    expect(memory.markdownWrites).toHaveLength(1);
  });

  it("releases an uncertain pending create after its file is renamed out of the managed set", async () => {
    const memory = createMemoryTaskApp({
      failCreatesAfterMutation: 1,
      metadataVisible: () => false
    });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const options = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Codex run · repository",
      repository: "/repository"
    };
    vi.spyOn(memory.app.vault, "read").mockRejectedValueOnce(
      new Error("simulated transient task read failure")
    );
    await expect(repository.ensure(options)).rejects.toThrow(
      "simulated post-create vault failure"
    );
    const originalPath = memory.createdPaths[0]!;
    const renamed = memory.renameFile(originalPath, originalPath.replace(/\.md$/, ".txt"));

    repository.invalidateVaultEvents([], [{ file: renamed, oldPath: originalPath }]);

    await expect(repository.ensure(options)).resolves.toMatchObject({
      created: true,
      task: { taskId: options.taskId, file: { path: originalPath } }
    });
    expect(memory.markdownWrites).toHaveLength(2);
  });

  it("does not trust task content read from a file that moves during verification", async () => {
    const memory = createMemoryTaskApp({ metadataVisible: () => false });
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const originalPath = "Agent Cockpit/Tasks/codex-run-repository.md";
    await memory.app.vault.createFolder("Agent Cockpit");
    await memory.app.vault.createFolder("Agent Cockpit/Tasks");
    await memory.app.vault.create(originalPath, taskMarkdown(taskId));
    const readTask = memory.app.vault.read.bind(memory.app.vault);
    vi.spyOn(memory.app.vault, "read").mockImplementationOnce(async (file) => {
      const markdown = await readTask(file);
      memory.renameFile(originalPath, "Agent Cockpit/Tasks/moved-during-read.md");
      return markdown;
    });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");

    await expect(repository.ensure({
      taskId,
      title: "Codex run · repository",
      repository: "/repository"
    })).rejects.toThrow("could not be verified safely");
    expect(memory.markdownWrites).toHaveLength(1);
    expect(memory.createdPaths).toHaveLength(1);
  });

  it("uses the next filename when readable task content proves a title collision", async () => {
    const memory = createMemoryTaskApp();
    await memory.app.vault.createFolder("Agent Cockpit");
    await memory.app.vault.createFolder("Agent Cockpit/Tasks");
    await memory.app.vault.create(
      "Agent Cockpit/Tasks/codex-run-repository.md",
      taskMarkdown("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    );
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");

    const result = await repository.ensure({
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Codex run · repository",
      repository: "/repository"
    });

    expect(result).toMatchObject({ created: true });
    expect(memory.createdPaths).toEqual([
      "Agent Cockpit/Tasks/codex-run-repository.md",
      "Agent Cockpit/Tasks/codex-run-repository-2.md"
    ]);
  });

  it("recovers an uncertain write at the end of a filename collision chain", async () => {
    const memory = createMemoryTaskApp({ failCreateAttemptsAfterMutation: [2] });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    await repository.create({ title: "Codex run · repository" });
    const options = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Codex run · repository",
      repository: "/repository"
    };
    const readTask = memory.app.vault.read.bind(memory.app.vault);
    let rejectSecondPathRead = true;
    vi.spyOn(memory.app.vault, "read").mockImplementation(async (file) => {
      if (file.path.endsWith("-2.md") && rejectSecondPathRead) {
        rejectSecondPathRead = false;
        throw new Error("simulated collision-path read failure");
      }
      return readTask(file);
    });

    await expect(repository.ensure(options)).rejects.toThrow(
      "simulated post-create vault failure"
    );
    await expect(repository.ensure(options)).resolves.toMatchObject({
      created: false,
      task: { taskId: options.taskId }
    });
    expect(memory.createdPaths).toEqual([
      "Agent Cockpit/Tasks/codex-run-repository.md",
      "Agent Cockpit/Tasks/codex-run-repository-2.md"
    ]);
  });

  it("does not hide a pending duplicate behind one indexed task match", async () => {
    const pendingPath = "Agent Cockpit/Tasks/codex-run-repository.md";
    const memory = createMemoryTaskApp({
      failCreatesAfterMutation: 1,
      metadataVisible: (file) => file.path !== pendingPath
    });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const options = {
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Codex run · repository",
      repository: "/repository"
    };
    vi.spyOn(memory.app.vault, "read").mockRejectedValueOnce(
      new Error("simulated transient task read failure")
    );
    await expect(repository.ensure(options)).rejects.toThrow(
      "simulated post-create vault failure"
    );
    await memory.app.vault.create(
      "Agent Cockpit/Tasks/indexed-duplicate.md",
      taskMarkdown(options.taskId, "Indexed duplicate")
    );

    await expect(repository.ensure(options)).rejects.toThrow(
      "automatic task ID is duplicated"
    );
    expect(memory.markdownWrites).toHaveLength(2);
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

  it("drops descendant write-through state for an exact task-folder event", async () => {
    const memory = createMemoryTaskApp();
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const task = await repository.create({ title: "No longer managed" });
    const taskFolder = memory.app.vault.getAbstractFileByPath("Agent Cockpit/Tasks");
    if (!(taskFolder instanceof TFolder)) throw new Error("Missing task folder fixture.");

    memory.replaceFrontmatter(task.file.path, {});
    expect(repository.list()).toMatchObject([{ taskId: task.taskId }]);

    repository.invalidateVaultEvents([{ file: taskFolder, path: taskFolder.path }], []);

    expect(repository.list()).toEqual([]);
  });

  it("drops unindexed write-through state after a generic file change", async () => {
    const memory = createMemoryTaskApp({ metadataVisible: () => false });
    const repository = new TaskRepository(memory.app, "Agent Cockpit/Tasks");
    const task = await repository.create({ title: "Changed before reindexing" });

    memory.replaceFrontmatter(task.file.path, {});
    repository.invalidateVaultEvents([{ file: task.file, path: task.file.path }], []);

    expect(repository.list()).toEqual([]);
    expect(() => repository.findById(task.taskId)).toThrow("The linked task no longer exists.");
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

    repository.invalidateVaultEvents([{ file: taskFile, path: taskFile.path }], []);
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
          path === root.path ? root : path === taskFile.path ? taskFile : null,
        read: async () => taskMarkdown(taskId.toUpperCase(), "Existing task")
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

  it("cancels a guarded workflow update when its runtime authority expires before the write", async () => {
    const taskFile = file("Agent Cockpit/Tasks/task.md");
    const root = folder("Agent Cockpit/Tasks", [taskFile]);
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const frontmatter: Record<string, unknown> = {
      "agent-cockpit": "task",
      "schema-version": 1,
      "task-id": taskId,
      title: "Guarded workflow task",
      "workflow-status": "active"
    };
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
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
        ) => {
          markWriteStarted();
          await writeGate;
          update(frontmatter);
        }
      }
    } as unknown as App;
    const repository = new TaskRepository(app, root.path);
    const currentTask = repository.findById(taskId);
    let allowed = true;

    const update = repository.updateWorkflowIfCurrent(currentTask, "review", () => allowed);
    await writeStarted;
    allowed = false;
    releaseWrite();

    await expect(update).resolves.toBe(false);
    expect(frontmatter["workflow-status"]).toBe("active");
    expect(repository.findById(taskId).workflowStatus).toBe("active");
  });

  it.each(["increment", "repair"] as const)(
    "keeps a queued run-count %s on its exact task when the configured folder changes",
    async (operation) => {
      let blockCreate = false;
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
          if (!blockCreate) return;
          markCreateStarted();
          await createGate;
        }
      });
      const repository = new TaskRepository(memory.app, "Folder A");
      const taskA = await repository.create({ title: "Exact task A" });
      repository.setTaskFolder("Folder B");
      const taskB = await repository.create({ title: "Different task B" });
      const taskBFrontmatter = memory.app.metadataCache.getFileCache(taskB.file)?.frontmatter;
      if (taskBFrontmatter === undefined) throw new Error("Missing task B frontmatter fixture.");
      memory.replaceFrontmatter(taskB.file.path, {
        ...taskBFrontmatter,
        "task-id": taskA.taskId
      });

      repository.setTaskFolder("Folder A");
      blockCreate = true;
      const blockingCreate = repository.create({ title: "Hold the task queue" });
      await createStarted;
      const update = operation === "increment"
        ? repository.incrementRunCount(taskA)
        : repository.ensureRunCountAtLeast(taskA, 1);
      repository.setTaskFolder("Folder B");
      releaseCreate();

      await blockingCreate;
      await expect(update).resolves.toBe(1);
      repository.setTaskFolder("Folder A");
      expect(repository.findById(taskA.taskId)).toMatchObject({
        title: "Exact task A",
        runCount: 1
      });
      repository.setTaskFolder("Folder B");
      expect(repository.findById(taskA.taskId)).toMatchObject({
        title: "Different task B",
        runCount: 0
      });
    }
  );

  it("keeps a queued workflow update on its exact task when the configured folder changes", async () => {
    let blockCreate = false;
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
        if (!blockCreate) return;
        markCreateStarted();
        await createGate;
      }
    });
    const repository = new TaskRepository(memory.app, "Folder A");
    const taskA = await repository.create({ title: "Exact workflow task A" });
    repository.setTaskFolder("Folder B");
    const taskB = await repository.create({ title: "Different workflow task B" });
    const taskBFrontmatter = memory.app.metadataCache.getFileCache(taskB.file)?.frontmatter;
    if (taskBFrontmatter === undefined) throw new Error("Missing task B frontmatter fixture.");
    memory.replaceFrontmatter(taskB.file.path, {
      ...taskBFrontmatter,
      "task-id": taskA.taskId
    });

    repository.setTaskFolder("Folder A");
    blockCreate = true;
    const blockingCreate = repository.create({ title: "Hold the workflow queue" });
    await createStarted;
    const update = repository.updateWorkflow(taskA, "review");
    repository.setTaskFolder("Folder B");
    releaseCreate();

    await blockingCreate;
    await update;
    repository.setTaskFolder("Folder A");
    expect(repository.findById(taskA.taskId)).toMatchObject({
      title: "Exact workflow task A",
      workflowStatus: "review"
    });
    repository.setTaskFolder("Folder B");
    expect(repository.findById(taskA.taskId)).toMatchObject({
      title: "Different workflow task B",
      workflowStatus: "active"
    });
  });
});
