import { describe, expect, it } from "vitest";
import type { LiveSession } from "../../src/state/types";
import type { TaskRecord } from "../../src/tasks/TaskSchema";
import { sortLiveFirst } from "../../src/views/KanbanPanel";

function task(taskId: string, updatedAt: string): TaskRecord {
  return { taskId, title: taskId, workflowStatus: "active", updatedAt } as TaskRecord;
}

describe("KanbanPanel", () => {
  it("puts tasks with a live cmux run first, then orders by recency", () => {
    const closedNew = task("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "2026-09-24T00:00:00.000Z");
    const liveOld = task("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "2026-09-01T00:00:00.000Z");
    const closedOld = task("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "2026-09-10T00:00:00.000Z");
    const sessions = [
      { linkedTaskId: liveOld.taskId, assessment: { surfacePresence: "present" } } as LiveSession
    ];

    expect(sortLiveFirst([closedOld, closedNew, liveOld], { sessions }).map((entry) => entry.taskId))
      .toEqual([liveOld.taskId, closedNew.taskId, closedOld.taskId]);
  });
});
