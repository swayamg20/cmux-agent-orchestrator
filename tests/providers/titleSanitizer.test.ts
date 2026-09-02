import { describe, expect, it } from "vitest";
import {
  MAX_PROVIDER_TITLE_LENGTH,
  sanitizeProviderTitle
} from "../../src/providers/titleSanitizer";

describe("sanitizeProviderTitle", () => {
  it("keeps one plain bounded line and removes terminal formatting", () => {
    expect(sanitizeProviderTitle("\u001b[31m# Build exact matching\u001b[0m\nsecret second line")).toBe(
      "Build exact matching"
    );
    expect(sanitizeProviderTitle("\u001b]0;spoofed\u0007Safe \u202etitle")).toBe("Safe title");
  });

  it("rejects empty values and truncates long provider text", () => {
    expect(sanitizeProviderTitle("\n \t")).toBeNull();
    const title = sanitizeProviderTitle("x".repeat(MAX_PROVIDER_TITLE_LENGTH + 20));
    expect(Array.from(title ?? "")).toHaveLength(MAX_PROVIDER_TITLE_LENGTH);
    expect(title?.endsWith("…")).toBe(true);
  });
});
