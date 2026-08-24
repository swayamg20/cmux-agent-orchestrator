import { INITIAL_COCKPIT_STATE, type CockpitState } from "./types";

export type StoreListener = (state: Readonly<CockpitState>) => void;

export class CockpitStore {
  private state: CockpitState = structuredClone(INITIAL_COCKPIT_STATE);
  private readonly listeners = new Set<StoreListener>();

  getState(): Readonly<CockpitState> {
    return this.state;
  }

  update(patch: Partial<CockpitState> | ((state: Readonly<CockpitState>) => Partial<CockpitState>)): void {
    const nextPatch = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...nextPatch };
    for (const listener of this.listeners) listener(this.state);
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.listeners.clear();
    this.state = structuredClone(INITIAL_COCKPIT_STATE);
  }
}

