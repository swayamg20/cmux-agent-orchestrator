import { describe, expect, it } from "vitest";
import { PreviewCache } from "../../src/runtime/PreviewCache";

function preview(text: string) {
  return {
    workspaceId: "workspace",
    surfaceId: "surface",
    text,
    observedAt: 1,
    truncated: false
  };
}

describe("PreviewCache", () => {
  it("evicts the least-recently-used preview and never exceeds its byte budget", () => {
    const cache = new PreviewCache({ entries: 2, bytes: 7 });
    cache.set("a", preview("aaa"));
    cache.set("b", preview("bbb"));
    expect(cache.get("a")?.text).toBe("aaa");
    cache.set("c", preview("ccc"));

    expect(cache.peek("b")).toBeNull();
    expect(cache.peek("a")?.text).toBe("aaa");
    expect(cache.byteSize).toBeLessThanOrEqual(7);
  });

  it("retains only current cmux surfaces", () => {
    const cache = new PreviewCache();
    cache.set("a", preview("a"));
    cache.set("b", preview("b"));
    cache.retain(new Set(["b"]));
    expect(cache.peek("a")).toBeNull();
    expect(cache.peek("b")).not.toBeNull();
  });
});
