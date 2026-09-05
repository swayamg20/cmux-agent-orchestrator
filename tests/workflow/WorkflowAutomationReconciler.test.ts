import { describe, expect, it, vi } from "vitest";
import type { TaskRepository } from "../../src/tasks/TaskRepository";
import type { TaskRecord, WorkflowStatus } from "../../src/tasks/TaskSchema";
import type { WorkflowProposal } from "../../src/workflow/WorkflowAutomationPolicy";
import {
  WorkflowAutomationReconciler,
  type WorkflowAutomationAuthority
} from "../../src/workflow/WorkflowAutomationReconciler";

const TASK_ID = "11111111-1111-4111-8111-111111111111";

function task(): TaskRecord {
  return {
    file: { path: "Agent Cockpit/Tasks/task.md", basename: "task" } as TaskRecord["file"],
    taskId: TASK_ID,
    title: "Review the agent output",
    workflowStatus: "active",
    priority: "normal",
    repository: "/repo",
    branch: null,
    worktree: null,
    createdAt: "2026-09-06T04:00:00.000Z",
    updatedAt: "2026-09-06T04:00:00.000Z",
    runCount: 1
  };
}

function proposal(): WorkflowProposal {
  return {
    id: `${TASK_ID}:review:evidence-1`,
    taskId: TASK_ID,
    sessionKey: "workspace:pane:surface",
    from: "active",
    to: "review",
    reason: "turn-finished",
    explanation: "The provider reported a completed turn.",
    confidence: "high",
    source: "provider-lifecycle",
    evidenceId: "evidence-1",
    observedAt: Date.parse("2026-09-06T04:00:00.000Z"),
    applyAutomatically: true
  };
}

function harness(update: TaskRepository["updateWorkflowIfCurrent"]): {
  authority: WorkflowAutomationAuthority;
  reconciler: WorkflowAutomationReconciler;
  publishTasks: ReturnType<typeof vi.fn>;
  onAutomaticError: ReturnType<typeof vi.fn>;
} {
  const repository = { updateWorkflowIfCurrent: update } as TaskRepository;
  const authority: WorkflowAutomationAuthority = {
    ready: true,
    mode: "safe-auto",
    repository,
    taskFolder: "Agent Cockpit/Tasks",
    tasks: [task()],
    proposals: [proposal()]
  };
  const publishTasks = vi.fn(async () => undefined);
  const onAutomaticError = vi.fn();
  return {
    authority,
    reconciler: new WorkflowAutomationReconciler({
      getAuthority: () => authority,
      publishTasks,
      onAutomaticError
    }),
    publishTasks,
    onAutomaticError
  };
}

describe("WorkflowAutomationReconciler", () => {
  it("applies and publishes a proposal only while its authority remains current", async () => {
    const update = vi.fn(async (
      _task: TaskRecord,
      _to: WorkflowStatus,
      canMutate: () => boolean
    ) => canMutate());
    const { reconciler, publishTasks } = harness(update);

    await expect(reconciler.apply(proposal())).resolves.toBe(true);

    expect(update).toHaveBeenCalledOnce();
    expect(publishTasks).toHaveBeenCalledOnce();
  });

  it("rejects a proposal that is absent from the current authority", async () => {
    const update = vi.fn(async () => true);
    const { authority, reconciler, publishTasks } = harness(update);
    authority.proposals = [];

    await expect(reconciler.apply(proposal())).resolves.toBe(false);

    expect(update).not.toHaveBeenCalled();
    expect(publishTasks).not.toHaveBeenCalled();
  });

  it("cancels queued automatic work before the durable mutation starts", async () => {
    const update = vi.fn(async () => true);
    const { reconciler } = harness(update);

    reconciler.schedule([proposal()]);
    reconciler.cancel();
    await reconciler.waitForIdle();

    expect(update).not.toHaveBeenCalled();
  });

  it("deduplicates the same pending automatic proposal", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = vi.fn(async (
      _task: TaskRecord,
      _to: WorkflowStatus,
      canMutate: () => boolean
    ) => {
      await gate;
      return canMutate();
    });
    const { reconciler } = harness(update);

    reconciler.schedule([proposal()]);
    reconciler.schedule([proposal()]);
    release();
    await reconciler.waitForIdle();

    expect(update).toHaveBeenCalledOnce();
  });

  it("rechecks authority inside the repository compare-and-set guard", async () => {
    let authority!: WorkflowAutomationAuthority;
    const update = vi.fn(async (
      _task: TaskRecord,
      _to: WorkflowStatus,
      canMutate: () => boolean
    ) => {
      authority.ready = false;
      return canMutate();
    });
    const current = harness(update);
    authority = current.authority;

    await expect(current.reconciler.apply(proposal())).resolves.toBe(false);

    expect(current.publishTasks).not.toHaveBeenCalled();
  });

  it("reports an identical automatic failure only once", async () => {
    const update = vi.fn(async () => {
      throw new Error("simulated write failure");
    });
    const { reconciler, onAutomaticError } = harness(update);

    reconciler.schedule([proposal()]);
    await reconciler.waitForIdle();
    reconciler.schedule([proposal()]);
    await reconciler.waitForIdle();

    expect(update).toHaveBeenCalledTimes(2);
    expect(onAutomaticError).toHaveBeenCalledOnce();
  });
});
