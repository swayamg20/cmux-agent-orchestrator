import { describe, expect, it, vi } from "vitest";
import { CockpitStore } from "../../src/state/CockpitStore";

describe("CockpitStore", () => {
  it("publishes one coherent state after a batch of updates", () => {
    const store = new CockpitStore();
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();

    store.batch(() => {
      store.update({ refreshing: true });
      store.update({ refreshing: false, lastRefreshAt: 123 });
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ refreshing: false, lastRefreshAt: 123 });
  });
});
