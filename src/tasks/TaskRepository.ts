import { randomUUID } from "node:crypto";
import {
  normalizePath,
  parseYaml,
  TFile,
  TFolder,
  type App,
  type TAbstractFile
} from "obsidian";
import { canonicalUuidEquals, normalizeCanonicalUuid } from "../security/identifiers";
import { pathAffectsTaskFolder } from "./TaskFolderEvents";
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

export interface TaskInvalidationEvidence {
  file: TAbstractFile;
  path: string;
}

export interface TaskRenameEvidence {
  file: TAbstractFile;
  oldPath: string;
}

type MutationGuard = () => boolean;

interface TaskVaultScope {
  tail: Promise<void>;
  recentTasksByFolder: Map<string, Map<string, TaskRecord>>;
  // Optional for compatibility with a coordinator left on `window` by an
  // earlier plugin instance during hot reload.
  pendingCreatesByFolder?: Map<string, Map<string, PendingTaskCreate>>;
  vaultEventGeneration?: number;
}

interface PendingTaskCreate {
  path: string;
  markdown: string;
  input: NewTaskInput;
  file: TFile | null;
}

type RawTaskClaim =
  | { kind: "task"; taskId: string }
  | { kind: "not-task" }
  | { kind: "unknown" };

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
const MAX_PENDING_CREATES_PER_FOLDER = 128;
const MAX_RAW_FRONTMATTER_CHARACTERS = 16_384;

function taskVaultScope(app: App): TaskVaultScope {
  const adapter = app.vault.adapter;
  const vaultIdentity = typeof adapter === "object" && adapter !== null
    ? adapter
    : app.vault;
  let scope = taskRepositoryCoordinator.vaults.get(vaultIdentity);
  if (scope === undefined) {
    scope = {
      tail: Promise.resolve(),
      recentTasksByFolder: new Map<string, Map<string, TaskRecord>>(),
      pendingCreatesByFolder: new Map<string, Map<string, PendingTaskCreate>>(),
      vaultEventGeneration: 0
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

  observesVaultPath(path: string): boolean {
    const folders = new Set([
      this.taskFolder,
      ...this.scope.pendingCreatesByFolder?.keys() ?? []
    ]);
    return [...folders].some((folder) => pathAffectsTaskFolder(path, folder));
  }

  invalidateVaultEvents(
    invalidations: readonly TaskInvalidationEvidence[],
    renames: readonly TaskRenameEvidence[]
  ): void {
    if (invalidations.length === 0 && renames.length === 0) return;
    this.scope.vaultEventGeneration = (this.scope.vaultEventGeneration ?? 0) + 1;
    for (const recentTasks of this.scope.recentTasksByFolder.values()) {
      for (const [taskId, task] of recentTasks) {
        const invalidated = invalidations.some((evidence) =>
          this.invalidationAffectsTask(task, evidence)
        );
        const renamed = renames.some(({ file }) => this.eventFileContainsTask(file, task.file));
        if (!invalidated && !renamed) continue;
        this.trustedRecentTasks.delete(task);
        if (
          invalidated ||
          !renames.some(({ file, oldPath }) => this.shouldBridgeRename(task, file, oldPath))
        ) {
          recentTasks.delete(taskId);
        }
      }
    }
    this.reconcilePendingVaultEvents(invalidations, renames);
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

  private taskFiles(taskFolder = this.taskFolder): TFile[] {
    const root = this.app.vault.getAbstractFileByPath(normalizePath(taskFolder));
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
    return this.enqueueMutation(async () => {
      const task = await this.createWithId(options, taskId, undefined, false);
      if (task === null) throw new Error("Task creation was cancelled.");
      return task;
    });
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
      const recovered = await this.recoverPendingCreate(taskId, matches);
      if (canMutate && !canMutate()) return null;
      const pendingElsewhere = await this.pendingCreateOutsideFolder(taskId, this.taskFolder);
      if (pendingElsewhere !== null) {
        throw occupiedTaskPathError(pendingElsewhere.file?.path ?? pendingElsewhere.path, "unknown");
      }
      const existing = recovered ?? matches[0] ?? null;
      await this.assertNoAdditionalTaskClaim(
        taskId,
        this.taskFolder,
        existing === null ? [] : [existing.file]
      );
      if (canMutate && !canMutate()) return null;
      if (existing !== null) return { task: existing, created: false };
      const task = canMutate
        ? await this.createWithId(options, taskId, canMutate, true)
        : await this.createWithId(options, taskId, undefined, true);
      return task === null ? null : { task, created: true };
    });
  }

  private async createWithId(
    options: CreateTaskOptions,
    taskId: string,
    canMutate: MutationGuard | undefined,
    deterministic: boolean
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
    const markdown = createTaskMarkdown(input);
    if (deterministic) await this.assertNoAdditionalTaskClaim(normalizedTaskId, taskFolder);
    if (canMutate && !canMutate()) return null;
    const path = deterministic
      ? await this.availableDeterministicPath(baseName, taskFolder, normalizedTaskId)
      : this.availablePath(baseName, taskFolder);
    if (deterministic) await this.assertNoAdditionalTaskClaim(normalizedTaskId, taskFolder);
    if (canMutate && !canMutate()) return null;
    if (!deterministic) {
      const file = await this.createFileWithVerifiedPostcondition(
        path,
        markdown,
        normalizedTaskId,
        taskFolder
      );
      const task = taskRecordFromCreate(file, input);
      this.rememberRecentTask(taskFolder, task);
      return task;
    }

    const pending: PendingTaskCreate = { path, markdown, input, file: null };
    const pendingCreates = this.pendingCreates(taskFolder)!;
    if (!pendingCreates.has(normalizedTaskId) && pendingCreates.size >= MAX_PENDING_CREATES_PER_FOLDER) {
      throw new Error("Too many task writes are awaiting verification. Refresh after Obsidian finishes indexing.");
    }
    pendingCreates.set(normalizedTaskId, pending);
    let file: TFile;
    try {
      file = await this.createFileWithVerifiedPostcondition(
        path,
        markdown,
        normalizedTaskId,
        taskFolder,
        pendingCreates
      );
    } catch (error) {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) pending.file = existing;
      else if (existing !== null) pendingCreates.delete(normalizedTaskId);
      throw error;
    }
    pending.file = file;
    await this.assertNoAdditionalTaskClaim(normalizedTaskId, taskFolder, [file]);
    pendingCreates.delete(normalizedTaskId);
    const task = taskRecordFromCreate(file, input);
    this.rememberRecentTask(taskFolder, task);
    return task;
  }

  private async createFileWithVerifiedPostcondition(
    path: string,
    markdown: string,
    taskId: string,
    taskFolder: string,
    pendingCreates?: Map<string, PendingTaskCreate>
  ): Promise<TFile> {
    try {
      return await this.app.vault.create(path, markdown);
    } catch (createError) {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (!(existing instanceof TFile)) throw createError;
      const currentMarkdown = await this.readStableMarkdown(existing, taskFolder);
      // Preserve the original create error when the exact write cannot be proven.
      if (currentMarkdown === null) throw createError;
      if (currentMarkdown === markdown) return existing;
      if (taskIdentityInMarkdown(currentMarkdown, taskId) === "different") {
        pendingCreates?.delete(taskId);
      }
      throw createError;
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

  private async availableDeterministicPath(
    baseName: string,
    taskFolder: string,
    taskId: string
  ): Promise<string> {
    const folder = normalizePath(taskFolder);
    let counter = 1;
    let path = normalizePath(`${folder}/${baseName}.md`);
    while (true) {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing === null) {
        const physicalExists = await this.physicalPathExists(path);
        if (physicalExists === false) return path;
        throw occupiedTaskPathError(path, "unknown");
      }
      if (existing instanceof TFile) {
        const identity = await this.readTaskIdentity(existing, taskId, taskFolder);
        if (identity !== "different") throw occupiedTaskPathError(path, identity);
      }
      counter += 1;
      path = normalizePath(`${folder}/${baseName}-${counter}.md`);
    }
  }

  private async recoverPendingCreate(
    taskId: string,
    indexedMatches: readonly TaskRecord[]
  ): Promise<TaskRecord | null> {
    const taskFolder = this.taskFolder;
    const pendingCreates = this.pendingCreates(taskFolder, false);
    const pending = pendingCreates?.get(taskId);
    if (pending === undefined) return null;
    const eventGeneration = this.scope.vaultEventGeneration ?? 0;

    const resolved = await this.resolvePendingFile(taskFolder, pending);
    this.assertTaskEvidenceUnchanged(eventGeneration);
    if (resolved === "unknown") throw occupiedTaskPathError(pending.path, "unknown");
    if (resolved === null) {
      this.clearPendingCreate(taskFolder, taskId);
      return null;
    }
    const file = resolved;

    const indexedAtPendingFile = indexedMatches.find((task) => task.file === file);
    if (indexedAtPendingFile !== undefined) {
      this.clearPendingCreate(taskFolder, taskId);
      return indexedAtPendingFile;
    }

    const currentMarkdown = await this.readStableMarkdown(file, taskFolder);
    this.assertTaskEvidenceUnchanged(eventGeneration);
    if (currentMarkdown === null) {
      throw occupiedTaskPathError(file.path, "unknown");
    }
    if (currentMarkdown !== pending.markdown) {
      const identity = taskIdentityInMarkdown(currentMarkdown, taskId);
      if (identity !== "different") throw occupiedTaskPathError(file.path, identity);
      this.clearPendingCreate(taskFolder, taskId);
      return null;
    }

    if (indexedMatches.some((task) => task.file !== file)) {
      throw new Error("The automatic task ID is duplicated in the vault.");
    }

    this.clearPendingCreate(taskFolder, taskId);
    const task = taskRecordFromCreate(file, pending.input);
    this.rememberRecentTask(taskFolder, task);
    return task;
  }

  private async assertNoAdditionalTaskClaim(
    taskId: string,
    taskFolder: string,
    allowedFiles: readonly TFile[] = []
  ): Promise<void> {
    const eventGeneration = this.scope.vaultEventGeneration ?? 0;
    const allowed = new Set(allowedFiles);
    const seenAllowed = new Set<TFile>();
    for (const file of this.taskFiles(taskFolder)) {
      const cached = parseTaskRecord(
        file,
        this.app.metadataCache.getFileCache(file)?.frontmatter
      );
      const raw = await this.readTaskClaim(file, taskFolder);
      this.assertTaskEvidenceUnchanged(eventGeneration);
      if (raw.kind === "unknown") throw occupiedTaskPathError(file.path, "unknown");
      if (
        cached !== null &&
        (raw.kind !== "task" || raw.taskId !== cached.taskId)
      ) {
        throw occupiedTaskPathError(file.path, "unknown");
      }
      if (allowed.has(file)) {
        if (raw.kind === "task" && raw.taskId === taskId) {
          seenAllowed.add(file);
          continue;
        }
        throw occupiedTaskPathError(file.path, "unknown");
      }
      if (raw.kind !== "task" || raw.taskId !== taskId) continue;
      if (cached !== null) {
        throw new Error("The automatic task ID is duplicated in the vault.");
      }
      throw occupiedTaskPathError(file.path, "same");
    }
    this.assertTaskEvidenceUnchanged(eventGeneration);
    for (const file of allowed) {
      if (!seenAllowed.has(file)) throw occupiedTaskPathError(file.path, "unknown");
    }
  }

  private async readTaskClaim(
    file: TFile,
    taskFolder = this.taskFolder
  ): Promise<RawTaskClaim> {
    const markdown = await this.readStableMarkdown(file, taskFolder);
    return markdown === null ? { kind: "unknown" } : taskClaimInMarkdown(markdown);
  }

  private async readTaskIdentity(
    file: TFile,
    taskId: string,
    taskFolder = this.taskFolder
  ): Promise<"same" | "different" | "unknown"> {
    const claim = await this.readTaskClaim(file, taskFolder);
    if (claim.kind === "unknown") return "unknown";
    if (claim.kind === "not-task") return "different";
    return claim.taskId === taskId ? "same" : "different";
  }

  private async readStableMarkdown(
    file: TFile,
    taskFolder = this.taskFolder
  ): Promise<string | null> {
    const path = normalizePath(file.path);
    if (
      file.extension !== "md" ||
      !this.isInTaskFolder(path, taskFolder) ||
      this.app.vault.getAbstractFileByPath(path) !== file
    ) {
      return null;
    }
    let markdown: string;
    try {
      markdown = await this.app.vault.read(file);
    } catch {
      return null;
    }
    return file.extension === "md" &&
      normalizePath(file.path) === path &&
      this.isInTaskFolder(path, taskFolder) &&
      this.app.vault.getAbstractFileByPath(path) === file
      ? markdown
      : null;
  }

  private livePendingFile(file: TFile | null, taskFolder: string): TFile | null {
    if (file === null) return null;
    const path = normalizePath(file.path);
    return file.extension === "md" &&
      this.isInTaskFolder(path, taskFolder) &&
      this.app.vault.getAbstractFileByPath(path) === file
      ? file
      : null;
  }

  private async resolvePendingFile(
    taskFolder: string,
    pending: PendingTaskCreate
  ): Promise<TFile | "unknown" | null> {
    const liveFile = this.livePendingFile(pending.file, taskFolder);
    if (liveFile !== null) return liveFile;

    if (pending.file !== null) {
      const currentPath = normalizePath(pending.file.path);
      if (this.app.vault.getAbstractFileByPath(currentPath) === pending.file) {
        // The exact file still exists, but it is no longer a managed Markdown
        // task in the folder where the uncertain write occurred.
        return null;
      }
    }

    const atOriginalPath = this.app.vault.getAbstractFileByPath(pending.path);
    if (atOriginalPath instanceof TFile) {
      pending.file = atOriginalPath;
      return this.livePendingFile(atOriginalPath, taskFolder);
    }
    if (atOriginalPath !== null) return null;
    const physicalExists = await this.physicalPathExists(pending.path);
    return physicalExists === false ? null : "unknown";
  }

  private async physicalPathExists(path: string): Promise<boolean | null> {
    const adapter = this.app.vault.adapter as typeof this.app.vault.adapter | undefined;
    if (adapter === undefined || typeof adapter.exists !== "function") return false;
    try {
      return await adapter.exists(normalizePath(path), true);
    } catch {
      return null;
    }
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

  private isInTaskFolder(path: string, taskFolder = this.taskFolder): boolean {
    return normalizePath(path).startsWith(`${normalizePath(taskFolder)}/`);
  }

  private recentTaskIsDisproved(task: TaskRecord): boolean {
    if (task.file.extension !== "md") return true;
    const currentFile = this.app.vault.getAbstractFileByPath(normalizePath(task.file.path));
    if (currentFile !== task.file) return true;
    if (this.trustedRecentTasks.has(task)) return false;
    const cache = this.app.metadataCache.getFileCache(task.file);
    if (cache === null) return false;
    const indexed = parseTaskRecord(task.file, cache.frontmatter);
    return indexed === null || indexed.taskId !== task.taskId;
  }

  private shouldBridgeRename(
    task: TaskRecord,
    renamedFile: TAbstractFile,
    oldPath: string
  ): boolean {
    const taskPath = normalizePath(task.file.path);
    const previousTaskPath = this.previousTaskPathForRename(task, renamedFile, oldPath);
    return previousTaskPath !== null &&
      task.file.extension === "md" &&
      this.isInTaskFolder(previousTaskPath) &&
      this.isInTaskFolder(taskPath) &&
      this.app.vault.getAbstractFileByPath(taskPath) === task.file &&
      this.app.metadataCache.getFileCache(task.file) === null;
  }

  private invalidationAffectsTask(
    task: TaskRecord,
    { file, path }: TaskInvalidationEvidence
  ): boolean {
    if (this.eventFileContainsTask(file, task.file)) return true;
    if (!(file instanceof TFolder)) return false;
    const taskPath = normalizePath(task.file.path);
    const eventPath = normalizePath(path);
    const liveEventFile = this.app.vault.getAbstractFileByPath(normalizePath(file.path));
    const liveTaskFile = this.app.vault.getAbstractFileByPath(taskPath);
    return liveEventFile === null &&
      liveTaskFile !== task.file &&
      (taskPath === eventPath || taskPath.startsWith(`${eventPath}/`));
  }

  private eventFileContainsTask(eventFile: TAbstractFile, taskFile: TFile): boolean {
    let current: TAbstractFile | null = taskFile;
    const visited = new Set<TAbstractFile>();
    while (current !== null && !visited.has(current)) {
      if (current === eventFile) return true;
      visited.add(current);
      current = current.parent ?? null;
    }
    if (!(eventFile instanceof TFolder)) return false;
    const eventPath = normalizePath(eventFile.path);
    const taskPath = normalizePath(taskFile.path);
    return this.app.vault.getAbstractFileByPath(eventPath) === eventFile &&
      this.app.vault.getAbstractFileByPath(taskPath) === taskFile &&
      taskPath.startsWith(`${eventPath}/`);
  }

  private previousTaskPathForRename(
    task: TaskRecord,
    renamedFile: TAbstractFile,
    oldPath: string
  ): string | null {
    if (task.file === renamedFile) return normalizePath(oldPath);
    if (!(renamedFile instanceof TFolder) || !this.eventFileContainsTask(renamedFile, task.file)) {
      return null;
    }
    const taskPath = normalizePath(task.file.path);
    const renamedFolderPath = normalizePath(renamedFile.path);
    if (this.app.vault.getAbstractFileByPath(renamedFolderPath) !== renamedFile) return null;
    if (!taskPath.startsWith(`${renamedFolderPath}/`)) return null;
    return normalizePath(`${normalizePath(oldPath)}${taskPath.slice(renamedFolderPath.length)}`);
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

  private pendingCreates(
    taskFolder = this.taskFolder,
    create = true
  ): Map<string, PendingTaskCreate> | undefined {
    const folder = normalizePath(taskFolder);
    let pendingByFolder = this.scope.pendingCreatesByFolder;
    if (pendingByFolder === undefined) {
      if (!create) return undefined;
      pendingByFolder = new Map<string, Map<string, PendingTaskCreate>>();
      this.scope.pendingCreatesByFolder = pendingByFolder;
    }
    let pendingCreates = pendingByFolder.get(folder);
    if (pendingCreates === undefined) {
      if (!create) return undefined;
      pendingCreates = new Map<string, PendingTaskCreate>();
      pendingByFolder.set(folder, pendingCreates);
    }
    return pendingCreates;
  }

  private clearPendingCreate(taskFolder: string, taskId: string): void {
    const folder = normalizePath(taskFolder);
    const pendingCreates = this.scope.pendingCreatesByFolder?.get(folder);
    if (pendingCreates === undefined) return;
    pendingCreates.delete(taskId);
    if (pendingCreates.size === 0) this.scope.pendingCreatesByFolder?.delete(folder);
  }

  private async pendingCreateOutsideFolder(
    taskId: string,
    taskFolder: string
  ): Promise<PendingTaskCreate | null> {
    const currentFolder = normalizePath(taskFolder);
    for (const [folder, pendingCreates] of this.scope.pendingCreatesByFolder ?? []) {
      if (folder === currentFolder) continue;
      const pending = pendingCreates.get(taskId);
      if (pending === undefined) continue;
      const eventGeneration = this.scope.vaultEventGeneration ?? 0;
      const resolved = await this.resolvePendingFile(folder, pending);
      this.assertTaskEvidenceUnchanged(eventGeneration);
      if (resolved === null) {
        this.clearPendingCreate(folder, taskId);
        continue;
      }
      if (resolved !== "unknown") {
        const identity = await this.readTaskIdentity(resolved, taskId, folder);
        this.assertTaskEvidenceUnchanged(eventGeneration);
        if (identity === "different") {
          this.clearPendingCreate(folder, taskId);
          continue;
        }
      }
      return pending;
    }
    return null;
  }

  private assertTaskEvidenceUnchanged(eventGeneration: number): void {
    if ((this.scope.vaultEventGeneration ?? 0) !== eventGeneration) {
      throw new Error("Task notes changed during verification. Refresh and try again.");
    }
  }

  private reconcilePendingVaultEvents(
    invalidations: readonly TaskInvalidationEvidence[],
    renames: readonly TaskRenameEvidence[]
  ): void {
    for (const [folder, pendingCreates] of this.scope.pendingCreatesByFolder ?? []) {
      for (const [taskId, pending] of pendingCreates) {
        const file = pending.file;
        if (file === null) continue;
        const affected = invalidations.some(({ file: changed }) =>
          this.eventFileContainsTask(changed, file)
        ) || renames.some(({ file: renamed }) =>
          this.eventFileContainsTask(renamed, file)
        );
        if (!affected) continue;
        const path = normalizePath(file.path);
        if (
          this.app.vault.getAbstractFileByPath(path) !== file ||
          file.extension !== "md" ||
          !this.isInTaskFolder(path, folder)
        ) {
          this.clearPendingCreate(folder, taskId);
        }
      }
    }
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

function taskRecordFromCreate(file: TFile, input: NewTaskInput): TaskRecord {
  return {
    file,
    taskId: input.taskId,
    title: input.title,
    workflowStatus: input.workflowStatus,
    priority: input.priority,
    repository: input.repository,
    branch: input.branch,
    worktree: input.worktree,
    createdAt: input.now,
    updatedAt: input.now,
    runCount: 0
  };
}

function taskIdentityInMarkdown(
  markdown: string,
  taskId: string
): "same" | "different" | "unknown" {
  const claim = taskClaimInMarkdown(markdown);
  if (claim.kind === "unknown") return "unknown";
  if (claim.kind === "not-task") return "different";
  return claim.taskId === taskId ? "same" : "different";
}

function taskClaimInMarkdown(markdown: string): RawTaskClaim {
  const firstLineEnd = markdown.indexOf("\n");
  if (firstLineEnd < 0 || markdown.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") {
    return { kind: "not-task" };
  }

  const prefix = markdown.slice(0, MAX_RAW_FRONTMATTER_CHARACTERS + 1);
  const closingFence = /^---[ \t]*\r?$/gm;
  closingFence.lastIndex = firstLineEnd + 1;
  const closingMatch = closingFence.exec(prefix);
  if (closingMatch === null) return { kind: "unknown" };
  const frontmatter = prefix.slice(firstLineEnd + 1, closingMatch.index);
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter);
  } catch {
    return { kind: "unknown" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "not-task" };
  }
  const raw = parsed as Record<string, unknown>;
  const hasTaskMarker = Object.prototype.hasOwnProperty.call(raw, "agent-cockpit");
  const hasTaskId = Object.prototype.hasOwnProperty.call(raw, "task-id");
  if (
    (hasTaskMarker && relevantFrontmatterKeyCount(frontmatter, "agent-cockpit") !== 1) ||
    (hasTaskId && relevantFrontmatterKeyCount(frontmatter, "task-id") !== 1)
  ) {
    return { kind: "unknown" };
  }
  if (raw["agent-cockpit"] !== "task") return { kind: "not-task" };
  if (!hasTaskId || typeof raw["task-id"] !== "string") return { kind: "unknown" };
  const normalized = normalizeCanonicalUuid(raw["task-id"]);
  return normalized === null
    ? { kind: "unknown" }
    : { kind: "task", taskId: normalized };
}

function relevantFrontmatterKeyCount(
  frontmatter: string,
  key: "agent-cockpit" | "task-id"
): number {
  const pattern = new RegExp(`^(?:${key}|"${key}"|'${key}')[ \\t]*:`, "gm");
  return [...frontmatter.matchAll(pattern)].length;
}

function occupiedTaskPathError(
  path: string,
  identity: "same" | "unknown"
): Error {
  return identity === "same"
    ? new Error(
      `A task with this automatic ID exists at ${path}, but Obsidian has not indexed it yet. Refresh and try again.`
    )
    : new Error(
      `The occupied task path ${path} could not be verified safely. Refresh and try again.`
    );
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
