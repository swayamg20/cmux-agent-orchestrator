import { describe, expect, it } from "vitest";
import { PreviewScheduler } from "../../src/runtime/PreviewScheduler";

describe("PreviewScheduler", () => {
  it("deduplicates simultaneous requests for the same surface", async () => {
    const scheduler = new PreviewScheduler(2);
    let loads = 0;
    const load = async () => {
      loads += 1;
      return { workspaceId: "w", paneId: "p", surfaceId: "s", text: "preview", observedAt: 1, truncated: false };
    };
    const first = scheduler.schedule("surface", load);
    const second = scheduler.schedule("surface", load);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(loads).toBe(1);
    scheduler.dispose();
  });

  it("recovers its concurrency slot after a loader throws synchronously", async () => {
    const scheduler = new PreviewScheduler(1);
    const failed = scheduler.schedule("failed", () => {
      throw new Error("synchronous preview failure");
    });
    const recovered = scheduler.schedule("recovered", async () => ({
      workspaceId: "w",
      paneId: "p",
      surfaceId: "s",
      text: "recovered preview",
      observedAt: 2,
      truncated: false
    }));

    await expect(failed).rejects.toThrow("synchronous preview failure");
    await expect(recovered).resolves.toMatchObject({ text: "recovered preview" });
    scheduler.dispose();
  });

  it("rejects requests queued after disposal instead of leaving them pending", async () => {
    const scheduler = new PreviewScheduler();
    let loads = 0;
    scheduler.dispose();

    await expect(
      scheduler.schedule("late", async () => {
        loads += 1;
        return { workspaceId: "w", paneId: "p", surfaceId: "s", text: "late", observedAt: 3, truncated: false };
      })
    ).rejects.toThrow("Preview scheduler was disposed.");
    expect(loads).toBe(0);
  });

  it("rejects an active request on disposal even when its loader never settles", async () => {
    const scheduler = new PreviewScheduler(1);
    let started = false;
    let settled = false;
    const pending = scheduler.schedule(
      "active",
      () => new Promise(() => {
        started = true;
      })
    );
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await Promise.resolve();
    expect(started).toBe(true);
    scheduler.dispose();
    await Promise.resolve();

    expect(settled).toBe(true);
    await expect(pending).rejects.toThrow("Preview scheduler was disposed.");
  });
});
