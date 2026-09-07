import { describe, expect, it } from "vitest";
import type { CockpitState, LiveSession } from "../../src/state/types";
import type { TaskRecord } from "../../src/tasks/TaskSchema";
import {
  canTriageNoLiveTasks,
  selectParkableNoLiveTasks,
  selectWorkBoardTasks,
  taskHasLiveSession
} from "../../src/views/WorkBoardModel";

function task(
  taskId: string,
  title: string,
  workflowStatus: TaskRecord["workflowStatus"],
  repository: string | null = null
): TaskRecord {
  return {
    taskId,
    title,
    workflowStatus,
    repository,
    branch: null,
    worktree: null
  } as TaskRecord;
}

function session(taskId: string | null, surfacePresence: "present" | "missing" = "present"): LiveSession {
  return {
    linkedTaskId: taskId,
    assessment: { surfacePresence }
  } as LiveSession;
}

function authority(
  connection: CockpitState["connection"]["status"] = "connected",
  topology: CockpitState["health"]["topology"]["status"] = "fresh",
  hasSnapshot = true
): Pick<CockpitState, "connection" | "health" | "snapshot"> {
  return {
    connection: { status: connection } as CockpitState["connection"],
    health: {
      topology: { status: topology },
      lifecycle: { status: "fresh" },
      notifications: { status: "fresh" }
    } as CockpitState["health"],
    snapshot: hasSnapshot ? ({} as CockpitState["snapshot"]) : null
  };
}

describe("WorkBoardModel", () => {
  const active = task("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Repair checkout", "active", "/repos/store");
  const review = task("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Review telemetry", "review", "/repos/observability");

  it("filters by task context and live-run presence without hiding workflow counts", () => {
    const state = {
      tasks: [active, review],
      sessions: [session(active.taskId)]
    };

    expect(selectWorkBoardTasks(state, "STORE", "all").tasks).toEqual([active]);
    expect(selectWorkBoardTasks(state, "", "live").tasks).toEqual([active]);
    expect(selectWorkBoardTasks(state, "", "no-live")).toMatchObject({
      tasks: [review],
      counts: { active: 0, review: 1 }
    });
  });

  it("does not treat a disappeared linked surface as a live run", () => {
    expect(taskHasLiveSession(active, [session(active.taskId, "missing")])).toBe(false);
    expect(taskHasLiveSession(active, [session(active.taskId, "present")])).toBe(true);
  });

  it("offers explicit parking only for active tasks under fresh connected topology", () => {
    const ready = {
      ...authority(),
      tasks: [active, review],
      sessions: []
    };
    expect(canTriageNoLiveTasks(ready)).toBe(true);
    expect(selectParkableNoLiveTasks(ready)).toEqual([active]);
    expect(selectParkableNoLiveTasks({ ...ready, ...authority("disconnected") })).toEqual([]);
    expect(selectParkableNoLiveTasks({ ...ready, ...authority("connected", "stale") })).toEqual([]);
    expect(selectParkableNoLiveTasks({ ...ready, ...authority("connected", "fresh", false) })).toEqual([]);
  });

  it("limits triage mode to active tasks without a live run", () => {
    const selected = selectWorkBoardTasks({
      tasks: [active, review],
      sessions: [session(review.taskId)]
    }, "", "all", true);

    expect(selected.tasks).toEqual([active]);
  });
});
