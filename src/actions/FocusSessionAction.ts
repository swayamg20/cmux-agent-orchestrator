import type { CmuxClient, FocusResult } from "../cmux/CmuxClient";
import type { CmuxTarget } from "../cmux/types";
import type { ConnectionState } from "../state/types";
import { ActionPolicy } from "./ActionPolicy";

export class FocusSessionAction {
  constructor(
    private readonly client: CmuxClient,
    private readonly policy = new ActionPolicy()
  ) {}

  execute(connection: ConnectionState, target: CmuxTarget, signal?: AbortSignal): Promise<FocusResult> {
    this.policy.assertCanFocus(connection, target);
    return this.client.focusExact(target, signal);
  }
}

