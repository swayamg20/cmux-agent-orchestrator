import type { CmuxTarget } from "../cmux/types";
import type { ConnectionState } from "../state/types";
import { validateFocusTarget } from "./validators";

export const MVP_ACTIONS = [
  "refresh",
  "focus-session",
  "open-task",
  "attach-task",
  "create-task",
  "detach-task",
  "copy-metadata"
] as const;

export type MvpAction = (typeof MVP_ACTIONS)[number];

export class ActionPolicy {
  assertAllowed(action: string): asserts action is MvpAction {
    if (!(MVP_ACTIONS as readonly string[]).includes(action)) {
      throw new Error(`Action is not allowed in Agent Cockpit v0.1: ${action}`);
    }
  }

  assertCanFocus(connection: ConnectionState, target: CmuxTarget): void {
    this.assertAllowed("focus-session");
    validateFocusTarget(target);
    if (connection.status !== "connected") {
      throw new Error("Agent Cockpit must have a live cmux connection before focusing a session.");
    }
  }
}

