import { describe, expect, it } from "vitest";
import type { AttentionItem, AttentionReason } from "../../src/state/types";
import type { TaskRecord } from "../../src/tasks/TaskSchema";
import { selectAttentionPresentation } from "../../src/views/NeedsAttentionPanel";

const task = {
  taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "Durable task"
} as TaskRecord;

function reason(kind: AttentionReason["kind"]): AttentionReason {
  return {
    kind,
    label: kind,
    detail: kind,
    severity: 3,
    confidence: "high",
    firstObservedAt: 1
  };
}

function item(key: string, reasons: AttentionReason[]): AttentionItem {
  return {
    key,
    session: null,
    task,
    reasons,
    severity: 3
  };
}

describe("NeedsAttentionPanel presentation", () => {
  it("collapses closed cmux surface links out of actionable attention", () => {
    const closed = item("closed", [reason("linked-surface-missing")]);
    const review = item("review", [reason("review-ready")]);

    expect(selectAttentionPresentation([closed, review])).toEqual({
      actionable: [review],
      closedSurfaceLinks: [closed]
    });
  });

  it("keeps a missing task actionable even when its surface also disappeared", () => {
    const missingTask = {
      ...item("missing-task", [
        reason("linked-task-missing"),
        reason("linked-surface-missing")
      ]),
      task: null
    };

    expect(selectAttentionPresentation([missingTask])).toEqual({
      actionable: [missingTask],
      closedSurfaceLinks: []
    });
  });
});
