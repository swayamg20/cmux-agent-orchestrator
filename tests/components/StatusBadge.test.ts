import { describe, expect, it } from "vitest";
import { phaseLabel } from "../../src/components/StatusBadge";

describe("phaseLabel", () => {
  it("labels execution evidence without pretending topology is runtime state", () => {
    expect(phaseLabel("unknown")).toBe("State unknown");
    expect(phaseLabel("waiting")).toBe("Needs input");
    expect(phaseLabel("working")).toBe("Working");
    expect(phaseLabel("idle")).toBe("Idle");
  });
});
