import type { TaskPriority, WorkflowStatus } from "./TaskSchema";

export interface NewTaskInput {
  title: string;
  taskId: string;
  workflowStatus: WorkflowStatus;
  priority: TaskPriority;
  repository: string | null;
  branch: string | null;
  worktree: string | null;
  now: string;
}

function yamlString(value: string | null): string {
  return value === null ? '""' : JSON.stringify(value);
}

function heading(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/^#+\s*/, "").trim().slice(0, 512) || "Untitled task";
}

export function createTaskMarkdown(input: NewTaskInput): string {
  return `---
agent-cockpit: task
schema-version: 1
task-id: ${yamlString(input.taskId)}
title: ${yamlString(heading(input.title))}
workflow-status: ${input.workflowStatus}
priority: ${input.priority}
repository: ${yamlString(input.repository)}
branch: ${yamlString(input.branch)}
worktree: ${yamlString(input.worktree)}
run-count: 0
created-at: ${yamlString(input.now)}
updated-at: ${yamlString(input.now)}
---

# ${heading(input.title)}

## Goal


## Acceptance criteria

- [ ]

## Context


## Current status


## Decisions


## Run history


## Outcome

`;
}
