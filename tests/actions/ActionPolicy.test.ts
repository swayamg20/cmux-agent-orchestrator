import { describe, expect, it } from "vitest";
import { ActionPolicy } from "../../src/actions/ActionPolicy";
import type { ConnectionState } from "../../src/state/types";

const target = {
  workspaceId: "22222222-2222-4222-8222-222222222222",
  paneId: "33333333-3333-4333-8333-333333333333",
  surfaceId: "44444444-4444-4444-8444-444444444444"
};

const connection = (status: ConnectionState["status"]): ConnectionState => ({
  status,
  message: status,
  versionText: null,
  accessMode: null,
  binaryPath: null,
  checkedAt: null
});

describe("ActionPolicy", () => {
  it("allows only the explicit action set without claiming a stale product version", () => {
    const policy = new ActionPolicy();
    expect(() => policy.assertAllowed("focus-session")).not.toThrow();
    expect(() => policy.assertAllowed("send-prompt")).toThrow(
      "Action is not allowed by cmux Agent Orchestrator: send-prompt"
    );
    expect(() => policy.assertAllowed("close-workspace")).toThrow(/not allowed/);
  });

  it("fails focus closed when disconnected or identity is not canonical", () => {
    const policy = new ActionPolicy();
    expect(() => policy.assertCanFocus(connection("disconnected"), target)).toThrow(/live cmux connection/);
    expect(() => policy.assertCanFocus(connection("connected"), { ...target, surfaceId: "surface:1" })).toThrow();
  });
});
