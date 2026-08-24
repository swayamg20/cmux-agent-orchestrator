import { INITIAL_COCKPIT_STATE, type CockpitState } from "./types";

export type StoreListener = (state: Readonly<CockpitState>) => void;

export class CockpitStore {
  private state: CockpitState = structuredClone(INITIAL_COCKPIT_STATE);
  private readonly listeners = new Set<StoreListener>();
  private batchDepth = 0;
  private notificationPending = false;

  getState(): Readonly<CockpitState> {
    return this.state;
  }

  update(patch: Partial<CockpitState> | ((state: Readonly<CockpitState>) => Partial<CockpitState>)): void {
    const nextPatch = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...nextPatch };
    this.notify();
  }

  batch(callback: () => void): void {
    this.batchDepth += 1;
    try {
      callback();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.notificationPending) {
        this.notificationPending = false;
        for (const listener of this.listeners) listener(this.state);
      }
    }
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.listeners.clear();
    this.state = structuredClone(INITIAL_COCKPIT_STATE);
    this.batchDepth = 0;
    this.notificationPending = false;
  }

  private notify(): void {
    if (this.batchDepth > 0) {
      this.notificationPending = true;
      return;
    }
    for (const listener of this.listeners) listener(this.state);
  }
}
