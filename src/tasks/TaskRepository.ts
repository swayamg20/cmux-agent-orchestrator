import { randomUUID } from "node:crypto";
import { normalizePath, TFile, TFolder, type App } from "obsidian";
import { canonicalUuidEquals, normalizeCanonicalUuid } from "../security/identifiers";
import { createTaskMarkdown, type NewTaskInput } from "./TaskTemplate";
import {
  assertWorkflowTransition,
  isWorkflowStatus,
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

type MutationGuard = () => boolean;

interface TaskVaultScope {
  tail: Promise<void>;
  recentTasksByFolder: Map<string, Map<string, TaskRecord>>;
}

interface TaskRepositoryCoordinator {
  vaults: WeakMap<object, TaskVaultScope>;
}

// Obsidian can replace the plugin instance while an earlier vault mutation is
// still settling. Keep the coordinator on the shared renderer global so the
// replacement instance cannot race that write or lose its write-through state.
const TASK_REPOSITORY_COORDINATOR_SYMBOL = Symbol.for(
  "obsidian.cmux-agent-orchestrator.task-repository-coordinator.v1"
);
const headlessTaskRepositoryHost = {};
const taskRepositoryHost = typeof window === "undefined" ? headlessTaskRepositoryHost : window;
const taskRepositoryGlobal = taskRepositoryHost as typeof taskRepositoryHost & {
  [TASK_REPOSITORY_COORDINATOR_SYMBOL]?: TaskRepositoryCoordinator;
};
const taskRepositoryCoordinator = taskRepositoryGlobal[TASK_REPOSITORY_COORDINATOR_SYMBOL] ??= {
  vaults: new WeakMap<object, TaskVaultScope>()
};

function taskVaultScope(app: App): TaskVaultScope {
  const adapter = app.vault.adapter;
  const vaultIdentity = typeof adapter === "object" && adapter !== null
    ? adapter
    : app.vault;
  let scope = taskRepositoryCoordinator.vaults.get(vaultIdentity);
  if (scope === undefined) {
    scope = {
      tail: Promise.resolve(),
      recentTasksByFolder: new Map<string, Map<string, TaskRecord>>()
    };
    taskRepositoryCoordinator.vaults.set(vaultIdentity, scope);
  }
  return scope;
}

export class TaskRepository {
  private readonly scope: TaskVaultScope;
  private trustedRecentTasks = new WeakSet<TaskRecord>();
  private taskFolder: string;

  constructor(
    private readonly app: App,
    taskFolder: string
  ) {
    this.taskFolder = normalizePath(taskFolder);
    this.scope = taskVaultScope(app);
  }

  setTaskFolder(taskFolder: string): void {
    const normalized = normalizePath(taskFolder);
    if (normalized !== this.taskFolder) {
      this.taskFolder = normalized;
      this.trustedRecentTasks = new WeakSet<TaskRecord>();
    }
  }

  invalidatePaths(paths: readonly string[]): void {
    const roots = paths.map((path) => normalizePath(path));
    if (roots.length === 0) return;
    for (const recentTasks of this.scope.recentTasksByFolder.values()) {
      for (const [taskId, task] of recentTasks) {
        const taskPath = normalizePath(task.file.path);
        if (roots.some((root) => taskPath === root || taskPath.startsWith(`${root}/`))) {
          recentTasks.delete(taskId);
          this.trustedRecentTasks.delete(task);
        }
      }
    }
  }

  list(): TaskRecord[] {
    const indexed = this.indexedTasks();
    const indexedByPath = new Map(
      indexed.map((task) => [normalizePath(task.file.path), task] as const)
    );
    const candidates = [...indexed];
    const recentTasks = this.recentTasks();
    for (const [taskId, task] of recentTasks) {
      const taskPath = normalizePath(task.file.path);
      if (
        !this.isInTaskFolder(taskPath) ||
        this.recentTaskIsDisproved(task)
      ) {
        recentTasks.delete(taskId);
        continue;
      }
      const indexedTask = indexedByPath.get(taskPath);
      if (indexedTask !== undefined && indexedTask.taskId !== taskId) {
        recentTasks.delete(taskId);
        continue;
      }
      candidates.push(task);
    }
    return unambiguousTaskSnapshots(candidates)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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
    const taskId = randomUUID();
    return this.enqueueMutation(() => this.createWithId(options, taskId));
  }

  async ensure(options: EnsureTaskOptions): Promise<EnsureTaskResult>;
  async ensure(
    options: EnsureTaskOptions,
    canMutate: MutationGuard
  ): Promise<EnsureTaskResult | null>;
  async ensure(
    options: EnsureTaskOptions,
    canMutate?: MutationGuard
  ): Promise<EnsureTaskResult | null> {
    const taskId = normalizeCanonicalUuid(options.taskId);
    if (taskId === null) throw new Error("Task ID is not a canonical UUID.");
    return this.enqueueMutation(async () => {
      if (canMutate && !canMutate()) return null;
      const matches = this.findMatchesById(taskId);
      if (matches.length > 1) throw new Error("The automatic task ID is duplicated in the vault.");
      if (matches[0]) return { task: matches[0], created: false };
      const task = canMutate
        ? await this.createWithId(options, taskId, canMutate)
        : await this.createWithId(options, taskId);
      return task === null ? null : { task, created: true };
    });
  }

  private async createWithId(options: CreateTaskOptions, taskId: string): Promise<TaskRecord>;
  private async createWithId(
    options: CreateTaskOptions,
    taskId: string,
    canMutate: MutationGuard
  ): Promise<TaskRecord | null>;
  private async createWithId(
    options: CreateTaskOptions,
    taskId: string,
    canMutate?: MutationGuard
  ): Promise<TaskRecord | null> {
    const title = options.title.replace(/[\r\n]+/g, " ").trim();
    if (!title) throw new Error("Task title is required.");
    if (title.length > 512) throw new Error("Task title must be 512 characters or fewer.");
    const normalizedTaskId = normalizeCanonicalUuid(taskId);
    if (normalizedTaskId === null) throw new Error("Task ID is not a canonical UUID.");
    const taskFolder = this.taskFolder;
    if (canMutate && !canMutate()) return null;
    if (!(await this.ensureFolder(taskFolder, canMutate))) return null;
    if (canMutate && !canMutate()) return null;
    const now = new Date().toISOString();
    const input: NewTaskInput = {
      title,
      taskId: normalizedTaskId,
      workflowStatus: options.workflowStatus ?? "active",
      priority: options.priority ?? "normal",
      repository: taskContext(options.repository, "Repository", 4_096),
      branch: taskContext(options.branch, "Branch", 512),
      worktree: taskContext(options.worktree, "Worktree", 4_096),
      now
    };
    const baseName = slugify(title);
    const path = this.availablePath(baseName, taskFolder);
    const markdown = createTaskMarkdown(input);
    const file = await this.createFileWithVerifiedPostcondition(path, markdown);
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
    this.rememberRecentTask(taskFolder, task);
    return task;
  }

  private async createFileWithVerifiedPostcondition(path: string, markdown: string): Promise<TFile> {
    try {
      return await this.app.vault.create(path, markdown);
    } catch (createError) {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (!(existing instanceof TFile)) throw createError;
      let exactWriteProven = false;
      try {
        exactWriteProven = (await this.app.vault.read(existing)) === markdown;
      } catch {
        // Preserve the original create error when the exact write cannot be proven.
      }
      if (!exactWriteProven) throw createError;
      return existing;
    }
  }

  async updateWorkflow(task: TaskRecord, workflowStatus: WorkflowStatus): Promise<void> {
    assertWorkflowTransition(task.workflowStatus, workflowStatus);
    return this.enqueueMutation(async () => {
      const latest = this.findById(task.taskId);
      const updatedAt = new Date().toISOString();
      await this.app.fileManager.processFrontMatter(latest.file, (frontmatter: Record<string, unknown>) => {
        if (!frontmatterTaskIdMatches(frontmatter["task-id"], task.taskId)) {
          throw new Error("Task identity changed before the update.");
        }
        if (workflowStatusFromFrontmatter(frontmatter["workflow-status"]) !== task.workflowStatus) {
          throw new Error("Task workflow changed before the update. Refresh and try again.");
        }
        frontmatter["workflow-status"] = workflowStatus;
        frontmatter["updated-at"] = updatedAt;
      });
      this.rememberRecentTask(this.taskFolder, { ...latest, workflowStatus, updatedAt });
    });
  }

  async incrementRunCount(task: TaskRecord): Promise<number> {
    return this.enqueueMutation(async () => {
      const latest = this.findById(task.taskId);
      let nextCount = task.runCount + 1;
      const updatedAt = new Date().toISOString();
      await this.app.fileManager.processFrontMatter(latest.file, (frontmatter: Record<string, unknown>) => {
        if (!frontmatterTaskIdMatches(frontmatter["task-id"], task.taskId)) {
          throw new Error("Task identity changed before the update.");
        }
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
      this.rememberRecentTask(this.taskFolder, { ...latest, runCount: nextCount, updatedAt });
      return nextCount;
    });
  }

  async ensureRunCountAtLeast(task: TaskRecord, minimum: number): Promise<number>;
  async ensureRunCountAtLeast(
    task: TaskRecord,
    minimum: number,
    canMutate: MutationGuard
  ): Promise<number | null>;
  async ensureRunCountAtLeast(
    task: TaskRecord,
    minimum: number,
    canMutate?: MutationGuard
  ): Promise<number | null> {
    if (!Number.isSafeInteger(minimum) || minimum < 0 || minimum > 1_000_000) {
      throw new Error("Minimum run count must be an integer between 0 and 1000000.");
    }
    return this.enqueueMutation(async () => {
      if (canMutate && !canMutate()) return null;
      const latest = this.findById(task.taskId);
      if (latest.runCount >= minimum) return latest.runCount;

      let nextCount = latest.runCount;
      let changed = false;
      let cancelled = false;
      const updatedAt = new Date().toISOString();
      if (canMutate && !canMutate()) return null;
      await this.app.fileManager.processFrontMatter(latest.file, (frontmatter: Record<string, unknown>) => {
        if (canMutate && !canMutate()) {
          cancelled = true;
          return;
        }
        if (!frontmatterTaskIdMatches(frontmatter["task-id"], task.taskId)) {
          throw new Error("Task identity changed before the update.");
        }
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
      if (cancelled) return null;
      if (changed) {
        this.rememberRecentTask(this.taskFolder, { ...latest, runCount: nextCount, updatedAt });
      }
      return nextCount;
    });
  }

  async open(task: TaskRecord): Promise<void> {
    const latest = this.findById(task.taskId);
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(latest.file);
  }

  private availablePath(baseName: string, taskFolder: string): string {
    const folder = normalizePath(taskFolder);
    let counter = 1;
    let path = normalizePath(`${folder}/${baseName}.md`);
    while (this.app.vault.getAbstractFileByPath(path) !== null) {
      counter += 1;
      path = normalizePath(`${folder}/${baseName}-${counter}.md`);
    }
    return path;
  }

  private async ensureFolder(folderPath: string, canMutate?: MutationGuard): Promise<boolean> {
    const normalized = normalizePath(folderPath);
    let current = "";
    for (const segment of normalized.split("/")) {
      if (canMutate && !canMutate()) return false;
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) throw new Error(`${current} is a file, not a folder.`);
      if (existing === null) {
        await this.app.vault.createFolder(current);
        if (canMutate && !canMutate()) return false;
      }
      else if (!(existing instanceof TFolder)) throw new Error(`${current} is not a folder.`);
    }
    return true;
  }

  private indexedTasks(): TaskRecord[] {
    return this.taskFiles()
      .map((file) => parseTaskRecord(file, this.app.metadataCache.getFileCache(file)?.frontmatter))
      .filter((task): task is TaskRecord => task !== null);
  }

  private findMatchesById(taskId: string): TaskRecord[] {
    const normalizedTaskId = normalizeCanonicalUuid(taskId);
    if (normalizedTaskId === null) return [];
    const indexed = this.indexedTasks();
    const matches = indexed.filter((task) => task.taskId === normalizedTaskId);
    const recentTasks = this.recentTasks();
    const recent = recentTasks.get(normalizedTaskId);
    if (recent === undefined) return matches;
    if (
      !this.isInTaskFolder(recent.file.path) ||
      this.recentTaskIsDisproved(recent)
    ) {
      recentTasks.delete(normalizedTaskId);
      return matches;
    }
    const indexedAtRecentPath = indexed.find(
      (task) => normalizePath(task.file.path) === normalizePath(recent.file.path)
    );
    if (indexedAtRecentPath !== undefined && indexedAtRecentPath.taskId !== normalizedTaskId) {
      recentTasks.delete(normalizedTaskId);
      return matches;
    }
    const indexedMatch = matches.findIndex((task) => task.file.path === recent.file.path);
    if (indexedMatch === -1) return [...matches, recent];
    const withRecentState = [...matches];
    withRecentState[indexedMatch] = reconcileTaskSnapshots(matches[indexedMatch]!, recent);
    return withRecentState;
  }

  private isInTaskFolder(path: string): boolean {
    return normalizePath(path).startsWith(`${this.taskFolder}/`);
  }

  private recentTaskIsDisproved(task: TaskRecord): boolean {
    const currentFile = this.app.vault.getAbstractFileByPath(normalizePath(task.file.path));
    if (currentFile !== task.file) return true;
    if (this.trustedRecentTasks.has(task)) return false;
    const cache = this.app.metadataCache.getFileCache(task.file);
    if (cache === null) return false;
    const indexed = parseTaskRecord(task.file, cache.frontmatter);
    return indexed === null || indexed.taskId !== task.taskId;
  }

  private rememberRecentTask(taskFolder: string, task: TaskRecord): void {
    this.recentTasks(taskFolder).set(task.taskId, task);
    this.trustedRecentTasks.add(task);
  }

  private recentTasks(taskFolder = this.taskFolder): Map<string, TaskRecord> {
    const folder = normalizePath(taskFolder);
    let recentTasks = this.scope.recentTasksByFolder.get(folder);
    if (recentTasks === undefined) {
      recentTasks = new Map<string, TaskRecord>();
      this.scope.recentTasksByFolder.set(folder, recentTasks);
    }
    return recentTasks;
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const operation = this.scope.tail.then(mutation, mutation);
    this.scope.tail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }
}

function unambiguousTaskSnapshots(candidates: TaskRecord[]): TaskRecord[] {
  const snapshots = new Map<string, TaskRecord>();
  const pathsByTaskId = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const path = normalizePath(candidate.file.path);
    const key = `${candidate.taskId}\0${path}`;
    const existing = snapshots.get(key);
    snapshots.set(
      key,
      existing === undefined ? candidate : reconcileTaskSnapshots(existing, candidate)
    );
    const paths = pathsByTaskId.get(candidate.taskId) ?? new Set<string>();
    paths.add(path);
    pathsByTaskId.set(candidate.taskId, paths);
  }
  return [...snapshots.values()].filter(
    (task) => pathsByTaskId.get(task.taskId)?.size === 1
  );
}

function reconcileTaskSnapshots(indexed: TaskRecord, recent: TaskRecord): TaskRecord {
  if (indexed.updatedAt > recent.updatedAt) return indexed;
  if (recent.updatedAt > indexed.updatedAt) return recent;
  return recent.runCount >= indexed.runCount
    ? recent
    : { ...recent, runCount: indexed.runCount };
}

function frontmatterTaskIdMatches(value: unknown, taskId: string): boolean {
  return typeof value === "string" && canonicalUuidEquals(value, taskId);
}

function workflowStatusFromFrontmatter(value: unknown): WorkflowStatus {
  return isWorkflowStatus(value) ? value : "backlog";
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
