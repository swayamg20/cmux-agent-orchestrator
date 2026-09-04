import { describe, expect, it } from "vitest";
import { resolveProviderDataRoot } from "../../src/providers/providerDataRoot";

describe("resolveProviderDataRoot", () => {
  it("normalizes a bounded absolute provider directory", () => {
    expect(resolveProviderDataRoot("/Users/test/config/../claude", "/fallback")).toBe(
      "/Users/test/claude"
    );
  });

  it.each([
    undefined,
    "",
    "relative/provider-root",
    "/tmp/provider\0escape",
    `/${"a".repeat(4_096)}`
  ])("falls back for an unsafe configured directory: %s", (configured) => {
    expect(resolveProviderDataRoot(configured, "/safe/fallback")).toBe("/safe/fallback");
  });
});
