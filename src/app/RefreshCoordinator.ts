import type { CmuxNotification, CmuxSnapshot } from "../cmux/types";

export interface RefreshSources {
  topology(signal: AbortSignal): Promise<CmuxSnapshot>;
  notifications(signal: AbortSignal): Promise<CmuxNotification[]>;
}

export interface RefreshResult {
  generation: number;
  current: boolean;
  snapshot: CmuxSnapshot | null;
  notifications: CmuxNotification[] | null;
  topologyError: unknown;
  notificationError: unknown;
}

export class RefreshCoordinator {
  private generation = 0;
  private active: { controller: AbortController; promise: Promise<RefreshResult> } | null = null;

  refresh(sources: RefreshSources, restart = false): Promise<RefreshResult> {
    if (this.active !== null && !restart) return this.active.promise;
    if (restart) this.active?.controller.abort();
    const generation = ++this.generation;
    const controller = new AbortController();
    const promise = this.perform(generation, controller, sources).finally(() => {
      if (this.active?.promise === promise) this.active = null;
    });
    this.active = { controller, promise };
    return promise;
  }

  dispose(): void {
    this.generation += 1;
    this.active?.controller.abort();
    this.active = null;
  }

  private async perform(
    generation: number,
    controller: AbortController,
    sources: RefreshSources
  ): Promise<RefreshResult> {
    const [topology, notifications] = await Promise.allSettled([
      sources.topology(controller.signal),
      sources.notifications(controller.signal)
    ]);
    return {
      generation,
      current: generation === this.generation && !controller.signal.aborted,
      snapshot: topology.status === "fulfilled" ? topology.value : null,
      notifications: notifications.status === "fulfilled" ? notifications.value : null,
      topologyError: topology.status === "rejected" ? topology.reason : null,
      notificationError: notifications.status === "rejected" ? notifications.reason : null
    };
  }
}
