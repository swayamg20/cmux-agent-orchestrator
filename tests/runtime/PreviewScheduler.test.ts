import { describe, expect, it } from "vitest";
import { PreviewScheduler } from "../../src/runtime/PreviewScheduler";

describe("PreviewScheduler", () => {
  it("deduplicates simultaneous requests for the same surface", async () => {
    const scheduler = new PreviewScheduler(2);
    let loads = 0;
    const load = async () => {
      loads += 1;
      return { workspaceId: "w", surfaceId: "s", text: "preview", observedAt: 1, truncated: false };
    };
    const first = scheduler.schedule("surface", load);
    const second = scheduler.schedule("surface", load);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(loads).toBe(1);
    scheduler.dispose();
  });
});
