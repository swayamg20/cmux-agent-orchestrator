import { describe, expect, it } from "vitest";
import { validateFocusTarget } from "../../src/actions/validators";

describe("action identity validation", () => {
  it("treats UUIDs that differ only by casing as the same identity", () => {
    expect(() =>
      validateFocusTarget({
        workspaceId: "a2222222-a222-4222-8222-a22222222222",
        paneId: "A2222222-A222-4222-8222-A22222222222",
        surfaceId: "c4444444-c444-4444-8444-c44444444444"
      })
    ).toThrow(/must be distinct/);
  });
});
