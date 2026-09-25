import type { LiveSession } from "../state/types";
import type { TaskRecord } from "./TaskSchema";
import { canonicalUuidEquals, normalizeCanonicalUuid } from "../security/identifiers";
import { sanitizeProviderTitle } from "../providers/titleSanitizer";
import { repositoryLabel } from "../components/SessionCard";
import { describeLiveRun } from "../views/MissionControlModel";

export const TASK_TITLE_STORAGE_KEY = "cmux-agent-orchestrator:task-titles:v1";
const MAX_CACHED_TITLES = 2_000;

export interface TitleStorage {
  load(key: string): unknown;
  save(key: string, data: unknown): void;
}

/**
 * Remembers the last descriptive title seen for each auto-named task, so a
 * card keeps saying what the work was after its cmux session closes.
 *
 * Titles live in Obsidian's per-device local storage, never in Markdown task
 * notes, so conversation-derived text does not enter synced vault files.
 */
export class TaskTitleCache {
  private titles: Record<string, string>;

  constructor(private readonly storage: TitleStorage | null) {
    this.titles = decode(storage?.load(TASK_TITLE_STORAGE_KEY));
  }

  current(): Readonly<Record<string, string>> {
    return this.titles;
  }

  /** Returns the same object when nothing changed, so renders stay cheap. */
  observe(
    tasks: readonly TaskRecord[],
    sessions: readonly LiveSession[]
  ): Readonly<Record<string, string>> {
    let next: Record<string, string> | null = null;
    for (const session of sessions) {
      const linkedTaskId = session.linkedTaskId;
      if (session.assessment.surfacePresence !== "present" || linkedTaskId === null) continue;
      const task = tasks.find((candidate) => canonicalUuidEquals(candidate.taskId, linkedTaskId));
      if (task === undefined) continue;
      const repository = repositoryLabel(task.repository ?? session.currentDirectory);
      const title = sanitizeProviderTitle(describeLiveRun(task, session, repository).title);
      if (title === null || title === task.title) continue;
      if ((next ?? this.titles)[task.taskId] === title) continue;
      next ??= { ...this.titles };
      delete next[task.taskId];
      next[task.taskId] = title;
    }
    if (next === null) return this.titles;
    const keys = Object.keys(next);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_CACHED_TITLES))) delete next[key];
    this.titles = next;
    try {
      this.storage?.save(TASK_TITLE_STORAGE_KEY, next);
    } catch {
      // Local storage is a convenience; the live title still renders.
    }
    return this.titles;
  }
}

export function displayTaskTitle(
  task: Pick<TaskRecord, "taskId" | "title">,
  titles: Readonly<Record<string, string>>
): string {
  return titles[task.taskId] ?? task.title;
}

function decode(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const titles: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(-MAX_CACHED_TITLES)) {
    const taskId = normalizeCanonicalUuid(key);
    const title = sanitizeProviderTitle(raw);
    if (taskId !== null && title !== null) titles[taskId] = title;
  }
  return titles;
}
