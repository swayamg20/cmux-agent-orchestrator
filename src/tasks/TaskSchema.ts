import type { TFile } from "obsidian";
import { normalizeCanonicalUuid } from "../security/identifiers";

export const WORKFLOW_STATUSES = ["backlog", "active", "review", "parked", "done"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface TaskRecord {
  file: TFile;
  taskId: string;
  title: string;
  workflowStatus: WorkflowStatus;
  priority: TaskPriority;
  repository: string | null;
  branch: string | null;
  worktree: string | null;
  createdAt: string;
  updatedAt: string;
  runCount: number;
}

function oneOf<T extends readonly string[]>(value: unknown, values: T, fallback: T[number]): T[number] {
  if (typeof value !== "string") return fallback;
  return values.find((candidate) => candidate === value) ?? fallback;
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function dateText(value: unknown, fallback: number): string {
  const candidate = optionalText(value, 64);
  const timestamp = candidate === null ? Number.NaN : Date.parse(candidate);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date(fallback).toISOString();
}

export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === "string" && WORKFLOW_STATUSES.some((candidate) => candidate === value);
}

export function parseTaskRecord(file: TFile, frontmatter: unknown): TaskRecord | null {
  if (typeof frontmatter !== "object" || frontmatter === null) return null;
  const raw = frontmatter as Record<string, unknown>;
  const taskId =
    typeof raw["task-id"] === "string"
      ? normalizeCanonicalUuid(raw["task-id"])
      : null;
  if (
    raw["agent-cockpit"] !== "task" ||
    raw["schema-version"] !== 1 ||
    taskId === null
  ) {
    return null;
  }
  const createdAt = dateText(raw["created-at"], file.stat.ctime);
  const updatedAt = dateText(raw["updated-at"], file.stat.mtime);
  const rawRunCount = raw["run-count"];
  return {
    file,
    taskId,
    title: optionalText(raw.title, 512) ?? file.basename.slice(0, 512),
    workflowStatus: oneOf(raw["workflow-status"], WORKFLOW_STATUSES, "backlog"),
    priority: oneOf(raw.priority, TASK_PRIORITIES, "normal"),
    repository: optionalText(raw.repository, 4_096),
    branch: optionalText(raw.branch, 512),
    worktree: optionalText(raw.worktree, 4_096),
    createdAt,
    updatedAt,
    runCount:
      typeof rawRunCount === "number" && Number.isFinite(rawRunCount) && rawRunCount >= 0
        ? Math.min(Math.floor(rawRunCount), 1_000_000)
        : 0
  };
}

export function assertWorkflowTransition(_from: WorkflowStatus, to: WorkflowStatus): void {
  if (!isWorkflowStatus(to)) throw new Error(`Invalid workflow status: ${String(to)}`);
}
