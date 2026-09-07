import type { CockpitState, LiveSession } from "../state/types";
import { canonicalUuidEquals } from "../security/identifiers";
import type { TaskRecord, WorkflowStatus } from "../tasks/TaskSchema";

export const WORK_BOARD_RUN_FILTERS = ["all", "live", "no-live"] as const;
export type WorkBoardRunFilter = (typeof WORK_BOARD_RUN_FILTERS)[number];

export interface WorkBoardSelection {
  tasks: TaskRecord[];
  counts: Record<WorkflowStatus, number>;
}

export function selectWorkBoardTasks(
  state: Pick<CockpitState, "tasks" | "sessions">,
  query: string,
  runFilter: WorkBoardRunFilter,
  triageMode = false
): WorkBoardSelection {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const tasks = state.tasks.filter((task) => {
    const hasLiveRun = taskHasLiveSession(task, state.sessions);
    if (triageMode && (task.workflowStatus !== "active" || hasLiveRun)) return false;
    if (runFilter === "live" && !hasLiveRun) return false;
    if (runFilter === "no-live" && hasLiveRun) return false;
    if (!normalizedQuery) return true;
    return [task.title, task.repository, task.branch, task.worktree]
      .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery) === true);
  });
  return {
    tasks,
    counts: countByWorkflow(tasks)
  };
}

export function selectParkableNoLiveTasks(
  state: Pick<CockpitState, "connection" | "health" | "snapshot" | "tasks" | "sessions">
): TaskRecord[] {
  if (!canTriageNoLiveTasks(state)) return [];
  return state.tasks.filter(
    (task) => task.workflowStatus === "active" && !taskHasLiveSession(task, state.sessions)
  );
}

export function canTriageNoLiveTasks(
  state: Pick<CockpitState, "connection" | "health" | "snapshot">
): boolean {
  return (
    state.connection.status === "connected" &&
    state.health.topology.status === "fresh" &&
    state.snapshot !== null
  );
}

export function taskHasLiveSession(
  task: Pick<TaskRecord, "taskId">,
  sessions: readonly Pick<LiveSession, "linkedTaskId" | "assessment">[]
): boolean {
  return sessions.some(
    (session) =>
      session.assessment.surfacePresence === "present" &&
      session.linkedTaskId !== null &&
      canonicalUuidEquals(session.linkedTaskId, task.taskId)
  );
}

function countByWorkflow(tasks: readonly TaskRecord[]): Record<WorkflowStatus, number> {
  const counts: Record<WorkflowStatus, number> = {
    backlog: 0,
    active: 0,
    review: 0,
    parked: 0,
    done: 0
  };
  for (const task of tasks) counts[task.workflowStatus] += 1;
  return counts;
}
