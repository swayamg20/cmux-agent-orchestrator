import { describe, expect, it } from "vitest";
import { cmuxCommands, isCanonicalUuid } from "../../src/cmux/commandBuilders";

const target = {
  workspaceId: "22222222-2222-4222-8222-222222222222",
  paneId: "33333333-3333-4333-8333-333333333333",
  surfaceId: "44444444-4444-4444-8444-444444444444"
};

describe("cmux command construction", () => {
  it("constructs exact JSON discovery arguments", () => {
    expect(cmuxCommands.tree()).toEqual(["--json", "--id-format", "uuids", "tree", "--all"]);
    expect(cmuxCommands.listNotifications()).toEqual([
      "--json",
      "--id-format",
      "uuids",
      "list-notifications"
    ]);
    expect(cmuxCommands.identifyFocused()).toEqual([
      "--json",
      "--id-format",
      "uuids",
      "identify",
      "--no-caller"
    ]);
  });

  it("constructs focus as an argument array with canonical IDs", () => {
    expect(cmuxCommands.focusPanel(target)).toEqual([
      "focus-panel",
      "--panel",
      target.surfaceId,
      "--workspace",
      target.workspaceId
    ]);
  });

  it("allows bounded provider evidence reads and rejects excessive lines", () => {
    expect(isCanonicalUuid("surface:1")).toBe(false);
    expect(() => cmuxCommands.focusPanel({ ...target, surfaceId: "$(touch /tmp/nope)" })).toThrow();
    expect(cmuxCommands.readScreen(target, 500)).toEqual([
      "--id-format",
      "uuids",
      "read-screen",
      "--workspace",
      target.workspaceId,
      "--surface",
      target.surfaceId,
      "--lines",
      "500"
    ]);
    expect(() => cmuxCommands.readScreen(target, 501)).toThrow(/between 1 and 500/);
  });
});
