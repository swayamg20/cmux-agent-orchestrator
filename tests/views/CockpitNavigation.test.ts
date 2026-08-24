import { describe, expect, it } from "vitest";
import { sectionForNavigationKey } from "../../src/views/CockpitNavigation";

describe("sectionForNavigationKey", () => {
  it("moves through Work, Agent runs, and cmux in both directions", () => {
    expect(sectionForNavigationKey("work", "ArrowRight")).toBe("agents");
    expect(sectionForNavigationKey("agents", "ArrowRight")).toBe("cmux");
    expect(sectionForNavigationKey("cmux", "ArrowRight")).toBe("work");
    expect(sectionForNavigationKey("work", "ArrowLeft")).toBe("cmux");
  });

  it("supports Home and End without intercepting unrelated keys", () => {
    expect(sectionForNavigationKey("cmux", "Home")).toBe("work");
    expect(sectionForNavigationKey("work", "End")).toBe("cmux");
    expect(sectionForNavigationKey("agents", "Enter")).toBeNull();
  });
});
