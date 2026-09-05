import type { TaskRepository } from "../tasks/TaskRepository";
import type { TaskRecord } from "../tasks/TaskSchema";
import type {
  WorkflowAutomationMode,
  WorkflowProposal
} from "./WorkflowAutomationPolicy";

export interface WorkflowAutomationAuthority {
  ready: boolean;
  mode: WorkflowAutomationMode;
  repository: TaskRepository | null;
  taskFolder: string | null;
  tasks: readonly TaskRecord[];
  proposals: readonly WorkflowProposal[];
}

export interface WorkflowAutomationReconcilerDependencies {
  getAuthority(): WorkflowAutomationAuthority;
  publishTasks(
    repository: TaskRepository,
    taskFolder: string,
    proposal: WorkflowProposal,
    automatic: boolean
  ): Promise<void>;
  onAutomaticError(proposal: WorkflowProposal, error: unknown): void;
}

/**
 * Serializes proposal writes and revalidates every authority input at the
 * durable Markdown mutation boundary. It never decides what should move; the
 * pure policy and proposal engine own that decision.
 */
export class WorkflowAutomationReconciler {
  private work: Promise<void> = Promise.resolve();
  private generation = 0;
  private disposed = false;
  private readonly pendingProposalIds = new Set<string>();
  private readonly reportedIssues = new Map<string, string>();

  constructor(private readonly dependencies: WorkflowAutomationReconcilerDependencies) {}

  async waitForIdle(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.work;
      await pending;
    } while (pending !== this.work);
  }

  cancel(): void {
    this.generation += 1;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.pendingProposalIds.clear();
    this.reportedIssues.clear();
  }

  schedule(proposals: readonly WorkflowProposal[]): void {
    const authority = this.dependencies.getAuthority();
    if (
      this.disposed ||
      !authority.ready ||
      authority.mode !== "safe-auto"
    ) {
      return;
    }
    const generation = this.generation;
    const candidates = proposals.filter(
      (proposal) =>
        proposal.applyAutomatically && !this.pendingProposalIds.has(proposal.id)
    );
    if (candidates.length === 0) return;
    for (const proposal of candidates) this.pendingProposalIds.add(proposal.id);

    this.work = this.work
      .catch(() => undefined)
      .then(async () => {
        for (const proposal of candidates) {
          try {
            const applied = await this.apply(proposal, true, generation);
            if (applied) this.reportedIssues.delete(proposal.id);
          } catch (error) {
            this.reportAutomaticError(proposal, error);
          } finally {
            this.pendingProposalIds.delete(proposal.id);
          }
        }
      });
  }

  async apply(
    proposal: WorkflowProposal,
    automatic = false,
    generation = this.generation
  ): Promise<boolean> {
    if (this.disposed) return false;
    const authority = this.dependencies.getAuthority();
    const current = findProposal(authority.proposals, proposal);
    const repository = authority.repository;
    const taskFolder = authority.taskFolder;
    const task = authority.tasks.find((candidate) => candidate.taskId === proposal.taskId);
    if (
      !authority.ready ||
      current === null ||
      repository === null ||
      taskFolder === null ||
      task === undefined ||
      (automatic &&
        (authority.mode !== "safe-auto" ||
          generation !== this.generation ||
          !current.applyAutomatically))
    ) {
      return false;
    }

    const canMutate = (): boolean => {
      const guardedAuthority = this.dependencies.getAuthority();
      if (
        this.disposed ||
        !guardedAuthority.ready ||
        guardedAuthority.repository !== repository ||
        guardedAuthority.taskFolder !== taskFolder ||
        (automatic &&
          (guardedAuthority.mode !== "safe-auto" || generation !== this.generation))
      ) {
        return false;
      }
      const guarded = findProposal(guardedAuthority.proposals, proposal);
      return guarded !== null && (!automatic || guarded.applyAutomatically);
    };

    const applied = await repository.updateWorkflowIfCurrent(task, proposal.to, canMutate);
    if (!applied) return false;
    await this.dependencies.publishTasks(repository, taskFolder, proposal, automatic);
    return true;
  }

  private reportAutomaticError(proposal: WorkflowProposal, error: unknown): void {
    if (this.disposed) return;
    const message = errorMessage(error);
    if (this.reportedIssues.get(proposal.id) === message) return;
    this.reportedIssues.set(proposal.id, message);
    this.dependencies.onAutomaticError(proposal, error);
  }
}

function findProposal(
  proposals: readonly WorkflowProposal[],
  expected: WorkflowProposal
): WorkflowProposal | null {
  return proposals.find(
    (candidate) =>
      candidate.id === expected.id &&
      candidate.taskId === expected.taskId &&
      candidate.sessionKey === expected.sessionKey &&
      candidate.from === expected.from &&
      candidate.to === expected.to
  ) ?? null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
