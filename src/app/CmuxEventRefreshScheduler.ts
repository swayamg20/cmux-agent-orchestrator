import { clearTimeout as cancelTimer, setTimeout as startTimer } from "node:timers";
import type { CmuxEventRefreshScope } from "../cmux/types";

const DEFAULT_COALESCE_MS = 100;

export interface CmuxEventRefreshDependencies {
  refreshAll(): Promise<void>;
  refreshTopology(): Promise<void>;
  refreshNotifications(): Promise<void>;
  refreshLifecycle(): Promise<void>;
  onError(error: unknown): void;
}

/**
 * Coalesces event bursts without polling. Snapshot commands remain the source
 * of truth; event envelopes only decide when those commands should run.
 */
export class CmuxEventRefreshScheduler {
  private readonly pending = new Set<CmuxEventRefreshScope>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly dependencies: CmuxEventRefreshDependencies,
    private readonly coalesceMs = DEFAULT_COALESCE_MS
  ) {}

  request(scope: CmuxEventRefreshScope): void {
    if (this.disposed) return;
    this.pending.add(scope);
    if (this.timer !== null || this.running !== null) return;
    this.timer = startTimer(() => {
      this.timer = null;
      void this.flushNow();
    }, this.coalesceMs);
    this.timer.unref();
  }

  async flushNow(): Promise<void> {
    if (this.disposed) return;
    if (this.timer !== null) {
      cancelTimer(this.timer);
      this.timer = null;
    }
    if (this.running !== null) {
      await this.running;
      if (this.pending.size > 0) await this.flushNow();
      return;
    }
    if (this.pending.size === 0) return;
    const scopes = new Set(this.pending);
    this.pending.clear();
    const work = this.perform(scopes)
      .catch((error: unknown) => {
        if (!this.disposed) this.dependencies.onError(error);
      })
      .finally(() => {
        if (this.running === work) this.running = null;
        if (this.pending.size > 0) this.scheduleNext();
      });
    this.running = work;
    await work;
  }

  async waitForIdle(): Promise<void> {
    while (!this.disposed && (this.timer !== null || this.running !== null || this.pending.size > 0)) {
      await this.flushNow();
    }
  }

  cancelPending(): void {
    if (this.timer !== null) cancelTimer(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending();
  }

  private scheduleNext(): void {
    if (this.disposed || this.timer !== null || this.running !== null || this.pending.size === 0) return;
    this.timer = startTimer(() => {
      this.timer = null;
      void this.flushNow();
    }, this.coalesceMs);
    this.timer.unref();
  }

  private async perform(scopes: ReadonlySet<CmuxEventRefreshScope>): Promise<void> {
    if (scopes.has("resync") || (scopes.has("topology") && scopes.has("notifications"))) {
      await this.dependencies.refreshAll();
      return;
    }
    const work: Promise<void>[] = [];
    if (scopes.has("topology")) work.push(this.dependencies.refreshTopology());
    if (scopes.has("notifications")) work.push(this.dependencies.refreshNotifications());
    // Topology refresh already schedules lifecycle resolution against the new
    // snapshot, so a concurrent lifecycle request would only duplicate work.
    if (scopes.has("lifecycle") && !scopes.has("topology")) {
      work.push(this.dependencies.refreshLifecycle());
    }
    await Promise.all(work);
  }
}
