import { describe, expect, it } from "vitest";
import { runtimeLabel } from "../../src/components/StatusBadge";

describe("runtimeLabel", () => {
  it("labels runtime state explicitly instead of showing an ambiguous bare value", () => {
    expect(runtimeLabel("unknown")).toBe("Runtime: Unknown");
    expect(runtimeLabel("needs-input")).toBe("Runtime: Needs input");
    expect(runtimeLabel("running")).toBe("Runtime: Running");
  });
});
