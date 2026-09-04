import { randomUUID } from "node:crypto";
import { normalizePath, TFile, TFolder, type App } from "obsidian";
import { isCanonicalUuid } from "../security/identifiers";
import { createTaskMarkdown, type NewTaskInput } from "./TaskTemplate";
import {
  assertWorkflowTransition,
  parseTaskRecord,
  type TaskPriority,
  type TaskRecord,
  type WorkflowStatus
} from "./TaskSchema";

export interface CreateTaskOptions {
  title: string;
  workflowStatus?: WorkflowStatus;
  priority?: TaskPriority;
  repository?: string | null;
  branch?: string | null;
  worktree?: string | null;
}

export interface EnsureTaskOptions extends CreateTaskOptions {
  taskId: string;
}

export interface EnsureTaskResult {
  task: TaskRecord;
  created: boolean;
}

export class TaskRepository {
  private readonly recentTasks = new Map<string, TaskRecord>();

  constructor(
    private readonly app: App,
    private taskFolder: string
  ) {}

  setTaskFolder(taskFolder: string): void {
    this.taskFolder = normalizePath(taskFolder);
  }

  list(): TaskRecord[] {
    const indexed = this.indexedTasks();
    const byId = new Map(indexed.map((task) => [task.taskId, task]));
    for (const [taskId, task] of this.recentTasks) {
      if (this.app.vault.getAbstractFileByPath(task.file.path) === null) this.recentTasks.delete(taskId);
      else if (!byId.has(taskId)) byId.set(taskId, task);
    }
    return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private taskFiles(): TFile[] {
    const root = this.app.vault.getAbstractFileByPath(normalizePath(this.taskFolder));
    if (!(root instanceof TFolder)) return [];
    const files: TFile[] = [];
    const pending = [root];
    while (pending.length > 0) {
      const folder = pending.pop()!;
      for (const child of folder.children) {
        if (child instanceof TFolder) pending.push(child);
        else if (child instanceof TFile && child.extension === "md") files.push(child);
      }
    }
    return files;
  }

  findById(taskId: string): TaskRecord {
    const matches = this.findMatchesById(taskId);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0 ? "The linked task no longer exists." : "The task ID is duplicated in the vault.");
    }
    return matches[0]!;
  }

  async create(options: CreateTaskOptions): Promise<TaskRecord> {
    return this.createWithId(options, randomUUID());
  }

  async ensure(options: EnsureTaskOptions): Promise<EnsureTaskResult> {
    if (!isCanonicalUuid(options.taskId)) throw new Error("Task ID is not a canonical UUID.");
    const matches = this.findMatchesById(options.taskId);
    if (matches.length > 1) throw new Error("The automatic task ID is duplicated in the vault.");
    if (matches[0]) return { task: matches[0], created: false };
    return { task: await this.createWithId(options, options.taskId), created: true };
  }

  private async createWithId(options: CreateTaskOptions, taskId: string): Promise<TaskRecord> {
    const title = options.title.replace(/[\r\n]+/g, " ").trim();
    if (!title) throw new Error("Task title is required.");
    if (title.length > 512) throw new Error("Task title must be 512 characters or fewer.");
    if (!isCanonicalUuid(taskId)) throw new Error("Task ID is not a canonical UUID.");
    await this.ensureFolder(this.taskFolder);
    const now = new Date().toISOString();
    const input: NewTaskInput = {
      title,
      taskId,
      workflowStatus: options.workflowStatus ?? "active",
      priority: options.priority ?? "normal",
      repository: taskContext(options.repository, "Repository", 4_096),
      branch: taskContext(options.branch, "Branch", 512),
      worktree: taskContext(options.worktree, "Worktree", 4_096),
      now
    };
    const baseName = slugify(title);
    const path = this.availablePath(baseName);
    const file = await this.app.vault.create(path, createTaskMarkdown(input));
    const task: TaskRecord = {
      file,
      taskId: input.taskId,
      title,
      workflowStatus: input.workflowStatus,
      priority: input.priority,
      repository: input.repository,
      branch: input.branch,
      worktree: input.worktree,
      createdAt: now,
      updatedAt: now,
      runCount: 0
    };
    this.recentTasks.set(task.taskId, task);
    return task;
  }

  async updateWorkflow(task: TaskRecord, workflowStatus: WorkflowStatus): Promise<void> {
    assertWorkflowTransition(task.workflowStatus, workflowStatus);
    const latest = this.findById(task.taskId);
    const updatedAt = new Date().toISOString();
    await this.app.fileManager.processFrontMatter(latest.file, (frontmatter: Record<string, unknown>) => {
      if (frontmatter["task-id"] !== task.taskId) throw new Error("Task identity changed before the update.");
      frontmatter["workflow-status"] = workflowStatus;
      frontmatter["updated-at"] = updatedAt;
    });
    this.recentTasks.set(task.taskId, { ...latest, workflowStatus, updatedAt });
  }

  async incrementRunCount(task: TaskRecord): Promise<number> {
    const latest = this.findById(task.taskId);
    let nextCount = task.runCount + 1;
    const updatedAt = new Date().toISOString();
    await this.app.fileManager.processFrontMatter(latest.file, (frontmatter: Record<string, unknown>) => {
      if (frontmatter["task-id"] !== task.taskId) throw new Error("Task identity changed before the update.");
      const current =
        typeof frontmatter["run-count"] === "number" &&
        Number.isFinite(frontmatter["run-count"]) &&
        frontmatter["run-count"] >= 0
          ? Math.min(Math.floor(frontmatter["run-count"]), 999_999)
          : 0;
      nextCount = current + 1;
      frontmatter["run-count"] = nextCount;
      frontmatter["updated-at"] = updatedAt;
    });
    this.recentTasks.set(task.taskId, { ...latest, runCount: nextCount, updatedAt });
    return nextCount;
  }

  async ensureRunCountAtLeast(task: TaskRecord, minimum: number): Promise<number> {
    if (!Number.isSafeInteger(minimum) || minimum < 0 || minimum > 1_000_000) {
      throw new Error("Minimum run count must be an integer between 0 and 1000000.");
    }
    const latest = this.findById(task.taskId);
    if (latest.runCount >= minimum) return latest.runCount;

    let nextCount = latest.runCount;
    let changed = false;
    const updatedAt = new Date().toISOString();
    await this.app.fileManager.processFrontMatter(latest.file, (frontmatter: Record<string, unknown>) => {
      if (frontmatter["task-id"] !== task.taskId) throw new Error("Task identity changed before the update.");
      const current =
        typeof frontmatter["run-count"] === "number" &&
        Number.isFinite(frontmatter["run-count"]) &&
        frontmatter["run-count"] >= 0
          ? Math.min(Math.floor(frontmatter["run-count"]), 1_000_000)
          : 0;
      nextCount = Math.max(current, minimum);
      if (nextCount === current) return;
      changed = true;
      frontmatter["run-count"] = nextCount;
      frontmatter["updated-at"] = updatedAt;
    });
    if (changed) this.recentTasks.set(task.taskId, { ...latest, runCount: nextCount, updatedAt });
    return nextCount;
  }

  async open(task: TaskRecord): Promise<void> {
    const latest = this.findById(task.taskId);
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(latest.file);
  }

  private availablePath(baseName: string): string {
    const folder = normalizePath(this.taskFolder);
    let counter = 1;
    let path = normalizePath(`${folder}/${baseName}.md`);
    while (this.app.vault.getAbstractFileByPath(path) !== null) {
      counter += 1;
      path = normalizePath(`${folder}/${baseName}-${counter}.md`);
    }
    return path;
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    let current = "";
    for (const segment of normalized.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) throw new Error(`${current} is a file, not a folder.`);
      if (existing === null) await this.app.vault.createFolder(current);
      else if (!(existing instanceof TFolder)) throw new Error(`${current} is not a folder.`);
    }
  }

  private indexedTasks(): TaskRecord[] {
    return this.taskFiles()
      .map((file) => parseTaskRecord(file, this.app.metadataCache.getFileCache(file)?.frontmatter))
      .filter((task): task is TaskRecord => task !== null);
  }

  private findMatchesById(taskId: string): TaskRecord[] {
    const matches = this.indexedTasks().filter((task) => task.taskId === taskId);
    const recent = this.recentTasks.get(taskId);
    if (recent === undefined) return matches;
    if (this.app.vault.getAbstractFileByPath(recent.file.path) === null) {
      this.recentTasks.delete(taskId);
      return matches;
    }
    return matches.some((task) => task.file.path === recent.file.path)
      ? matches
      : [...matches, recent];
  }
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "task";
}

function taskContext(value: string | null | undefined, label: string, maxLength: number): string | null {
  if (value == null) return null;
  const normalized = value.replace(/[\r\n\0]+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new Error(`${label} must be ${String(maxLength)} characters or fewer.`);
  return normalized;
}
