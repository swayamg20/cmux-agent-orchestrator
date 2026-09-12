import { describe, expect, it } from "vitest";
import { cmuxCommands, isCanonicalUuid } from "../../src/cmux/commandBuilders";

const target = {
  workspaceId: "22222222-2222-4222-8222-222222222222",
  paneId: "33333333-3333-4333-8333-333333333333",
  surfaceId: "44444444-4444-4444-8444-444444444444"
};
const windowId = "11111111-1111-4111-8111-111111111111";

describe("cmux command construction", () => {
  it("constructs exact JSON discovery arguments", () => {
    expect(cmuxCommands.tree()).toEqual(["--json", "--id-format", "uuids", "tree", "--all"]);
    expect(cmuxCommands.listNotifications()).toEqual([
      "--json",
      "--id-format",
      "uuids",
      "list-notifications"
    ]);
    expect(cmuxCommands.listAgents()).toEqual([
      "--json",
      "--id-format",
      "uuids",
      "list-agents"
    ]);
    expect(cmuxCommands.sessions()).toEqual(["sessions", "--json"]);
    expect(cmuxCommands.eventsHelp()).toEqual(["events", "--help"]);
    expect(cmuxCommands.identifyFocused()).toEqual([
      "--json",
      "--id-format",
      "uuids",
      "identify",
      "--no-caller"
    ]);
  });

  it("constructs focus as an argument array with canonical IDs", () => {
    expect(cmuxCommands.focusPanel(target, windowId)).toEqual([
      "focus-panel",
      "--panel",
      target.surfaceId,
      "--workspace",
      target.workspaceId,
      "--window",
      windowId
    ]);
  });

  it("allows bounded provider evidence reads and rejects excessive lines", () => {
    expect(isCanonicalUuid("surface:1")).toBe(false);
    expect(() => cmuxCommands.focusPanel({ ...target, surfaceId: "$(touch /tmp/nope)" }, windowId)).toThrow();
    expect(() => cmuxCommands.focusPanel(target, "$(touch /tmp/nope)")).toThrow();
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
