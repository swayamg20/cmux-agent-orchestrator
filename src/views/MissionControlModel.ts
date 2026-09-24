import type { CockpitState, LiveSession } from "../state/types";
import { canonicalUuidEquals } from "../security/identifiers";
import type { TaskRecord } from "../tasks/TaskSchema";
import { repositoryLabel } from "../components/SessionCard";

export interface MissionControlStats {
  live: number;
  review: number;
  parked: number;
  archived: number;
}

export interface LiveRow {
  session: LiveSession;
  task: TaskRecord;
}

export interface LiveGroup {
  repository: string;
  rows: LiveRow[];
}

export interface MissionControl {
  stats: MissionControlStats;
  liveGroups: LiveGroup[];
  archived: TaskRecord[];
}

/**
 * Splits durable tasks into what is running now and what is archived.
 * A task is archived when none of its cmux surfaces are open and it is not
 * waiting on a human (Review) or deliberately set aside (Parked, Backlog).
 */
export function selectMissionControl(
  state: Pick<CockpitState, "tasks" | "sessions" | "attention">
): MissionControl {
  const attentionSessionKeys = new Set(
    state.attention.flatMap((item) => (item.session ? [item.session.key] : []))
  );
  const groups = new Map<string, LiveRow[]>();
  let live = 0;
  const archived: TaskRecord[] = [];

  for (const task of state.tasks) {
    const sessions = state.sessions.filter(
      (session) =>
        session.assessment.surfacePresence === "present" &&
        session.linkedTaskId !== null &&
        canonicalUuidEquals(session.linkedTaskId, task.taskId)
    );
    if (sessions.length === 0) {
      if (task.workflowStatus === "active" || task.workflowStatus === "done") archived.push(task);
      continue;
    }
    live += 1;
    for (const session of sessions) {
      if (attentionSessionKeys.has(session.key)) continue;
      const repository = repositoryName(task, session);
      const rows = groups.get(repository) ?? [];
      rows.push({ session, task });
      groups.set(repository, rows);
    }
  }

  const liveGroups = [...groups.entries()]
    .map(([repository, rows]) => ({
      repository,
      rows: rows.sort((left, right) => lastActivity(right.session) - lastActivity(left.session))
    }))
    .sort((left, right) => left.repository.localeCompare(right.repository));

  archived.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return {
    stats: {
      live,
      review: state.tasks.filter((task) => task.workflowStatus === "review").length,
      parked: state.tasks.filter((task) => task.workflowStatus === "parked").length,
      archived: archived.length
    },
    liveGroups,
    archived
  };
}

export function lastActivity(session: Pick<LiveSession, "assessment" | "observedAt">): number {
  return session.assessment.lastActivityAt ?? session.observedAt;
}

function repositoryName(task: TaskRecord, session: LiveSession): string {
  if (task.repository) return repositoryLabel(task.repository);
  return repositoryLabel(session.currentDirectory);
}
