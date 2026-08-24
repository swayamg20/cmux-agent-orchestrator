import { describe, expect, it } from "vitest";
import { RefreshCoordinator } from "../../src/app/RefreshCoordinator";

const snapshot = { observedAt: 1, windows: [] };

describe("RefreshCoordinator", () => {
  it("coalesces concurrent refresh requests", async () => {
    let resolveTopology: ((value: typeof snapshot) => void) | null = null;
    const coordinator = new RefreshCoordinator();
    const sources = {
      topology: async () => new Promise<typeof snapshot>((resolve) => {
        resolveTopology = resolve;
      }),
      notifications: async () => []
    };
    const first = coordinator.refresh(sources);
    const second = coordinator.refresh(sources);
    expect(second).toBe(first);
    resolveTopology!(snapshot);
    await expect(first).resolves.toMatchObject({ current: true, snapshot });
  });

  it("returns successful sources when another source fails", async () => {
    const coordinator = new RefreshCoordinator();
    const result = await coordinator.refresh({
      topology: async () => snapshot,
      notifications: async () => {
        throw new Error("notifications unavailable");
      }
    });
    expect(result.snapshot).toEqual(snapshot);
    expect(result.notifications).toBeNull();
    expect(result.notificationError).toBeInstanceOf(Error);
  });

  it("marks a superseded generation as non-current", async () => {
    const coordinator = new RefreshCoordinator();
    const first = coordinator.refresh({
      topology: async (signal) => new Promise<typeof snapshot>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
      notifications: async () => []
    });
    const second = coordinator.refresh({
      topology: async () => snapshot,
      notifications: async () => []
    }, true);
    await expect(first).resolves.toMatchObject({ current: false });
    await expect(second).resolves.toMatchObject({ current: true, snapshot });
  });
});
