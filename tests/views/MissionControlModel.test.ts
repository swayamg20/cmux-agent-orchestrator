import { describe, expect, it } from "vitest";
import type { AttentionItem, LiveSession } from "../../src/state/types";
import type { TaskRecord } from "../../src/tasks/TaskSchema";
import { selectMissionControl } from "../../src/views/MissionControlModel";

function task(
  taskId: string,
  title: string,
  workflowStatus: TaskRecord["workflowStatus"],
  repository: string | null = null,
  updatedAt = "2026-09-24T00:00:00.000Z"
): TaskRecord {
  return { taskId, title, workflowStatus, repository, updatedAt } as TaskRecord;
}

function session(
  key: string,
  taskId: string | null,
  lastActivityAt: number,
  surfacePresence: "present" | "missing" = "present"
): LiveSession {
  return {
    key,
    linkedTaskId: taskId,
    currentDirectory: "/repos/fallback",
    observedAt: 0,
    assessment: { surfacePresence, lastActivityAt }
  } as LiveSession;
}

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("MissionControlModel", () => {
  it("groups live runs by repository with the most recent activity first", () => {
    const mission = selectMissionControl({
      tasks: [
        task(A, "Older store run", "active", "/repos/store"),
        task(B, "Newer store run", "active", "/repos/store"),
        task(C, "Agent run", "active", "/repos/agent")
      ],
      sessions: [session("s1", A, 100), session("s2", B, 200), session("s3", C, 50)],
      attention: []
    });

    expect(mission.liveGroups.map((group) => group.repository)).toEqual(["agent", "store"]);
    expect(mission.liveGroups[1]!.rows.map((row) => row.task.title)).toEqual([
      "Newer store run",
      "Older store run"
    ]);
    expect(mission.stats.live).toBe(3);
  });

  it("archives active and done tasks whose cmux sessions are all closed", () => {
    const mission = selectMissionControl({
      tasks: [
        task(A, "Closed active", "active", null, "2026-09-20T00:00:00.000Z"),
        task(B, "Closed done", "done", null, "2026-09-22T00:00:00.000Z"),
        task(C, "Closed review", "review"),
        task(D, "Parked", "parked"),
        task(E, "Planned", "backlog")
      ],
      sessions: [session("s1", A, 100, "missing")],
      attention: []
    });

    expect(mission.archived.map((entry) => entry.title)).toEqual(["Closed done", "Closed active"]);
    expect(mission.liveGroups).toEqual([]);
    expect(mission.stats).toEqual({ live: 0, review: 1, parked: 1, archived: 2 });
  });

  it("keeps runs that already need attention out of Live now without losing the live count", () => {
    const reviewSession = session("s1", A, 100);
    const mission = selectMissionControl({
      tasks: [task(A, "Needs review", "review", "/repos/store")],
      sessions: [reviewSession],
      attention: [{ key: "s1", session: reviewSession } as AttentionItem]
    });

    expect(mission.liveGroups).toEqual([]);
    expect(mission.stats.live).toBe(1);
  });

  it("falls back to the session directory when the task has no repository", () => {
    const mission = selectMissionControl({
      tasks: [task(A, "No repo", "active")],
      sessions: [session("s1", A, 100)],
      attention: []
    });

    expect(mission.liveGroups[0]?.repository).toBe("fallback");
  });
});
