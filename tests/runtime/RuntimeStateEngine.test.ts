import { describe, expect, it } from "vitest";
import { RuntimeStateEngine } from "../../src/runtime/RuntimeStateEngine";

const preview = (text: string, observedAt: number) => ({
  workspaceId: "22222222-2222-4222-8222-222222222222",
  surfaceId: "44444444-4444-4444-8444-444444444444",
  text,
  observedAt,
  truncated: false
});

describe("RuntimeStateEngine", () => {
  it("does not claim running from the first screen observation", () => {
    const engine = new RuntimeStateEngine();
    const result = engine.assess({
      key: "surface",
      notifications: [],
      preview: preview("initial output", 1_000),
      observedAt: 1_000,
      staleAfterMs: 60_000
    });
    expect(result.state).toBe("unknown");
    expect(result.evidence.confidence).toBe("low");
  });

  it("uses changed output as low-confidence running evidence", () => {
    const engine = new RuntimeStateEngine();
    engine.assess({ key: "surface", notifications: [], preview: preview("one", 1_000), observedAt: 1_000, staleAfterMs: 60_000 });
    const result = engine.assess({
      key: "surface",
      notifications: [],
      preview: preview("two", 2_000),
      observedAt: 2_000,
      staleAfterMs: 60_000
    });
    expect(result.state).toBe("running");
    expect(result.evidence.source).toBe("screen-change");
  });

  it.each([
    "The implementation requires explicit approval before deployment.",
    "Please confirm the documented behavior in the review.",
    "The dashboard label says needs input when runtime evidence is unavailable."
  ])("does not turn ordinary preview prose into a needs-input state: %s", (text) => {
    const result = new RuntimeStateEngine().assess({
      key: "surface",
      notifications: [],
      preview: preview(text, 1_000),
      observedAt: 1_000,
      staleAfterMs: 60_000
    });

    expect(result.state).toBe("unknown");
    expect(result.evidence.source).toBe("surface-presence");
  });

  it("derives needs-input from an unread structured notification", () => {
    const engine = new RuntimeStateEngine();
    const result = engine.assess({
      key: "surface",
      notifications: [
        {
          id: "notification",
          workspaceId: "workspace",
          surfaceId: "surface",
          title: "Approval required",
          subtitle: "Claude is waiting",
          body: "Please approve the action",
          isRead: false
        }
      ],
      preview: null,
      observedAt: 2_000,
      staleAfterMs: 60_000
    });
    expect(result.state).toBe("needs-input");
    expect(result.evidence.confidence).toBe("medium");
  });

  it("never maps an apparent completion to workflow done", () => {
    const engine = new RuntimeStateEngine();
    const result = engine.assess({
      key: "surface",
      notifications: [
        {
          id: "notification",
          workspaceId: "workspace",
          surfaceId: "surface",
          title: "Implementation complete",
          subtitle: "",
          body: "Ready for review",
          isRead: false
        }
      ],
      preview: null,
      observedAt: 2_000,
      staleAfterMs: 60_000
    });
    expect(result.state).toBe("idle");
    expect(String(result.state)).not.toBe("done");
  });
});
