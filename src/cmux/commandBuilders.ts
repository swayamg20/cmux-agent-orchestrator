import { CmuxError, type CmuxTarget } from "./types";
import { isCanonicalUuid } from "../security/identifiers";

export { isCanonicalUuid } from "../security/identifiers";

export const CMUX_MAX_PREVIEW_LINES = 500;

export function assertCanonicalUuid(value: string, label: string): void {
  if (!isCanonicalUuid(value)) {
    throw new CmuxError("target-ambiguous", `${label} is not a canonical UUID.`);
  }
}

export function assertTarget(target: CmuxTarget): void {
  assertCanonicalUuid(target.workspaceId, "Workspace ID");
  assertCanonicalUuid(target.paneId, "Pane ID");
  assertCanonicalUuid(target.surfaceId, "Surface ID");
}

export const cmuxCommands = {
  version(): readonly string[] {
    return ["--version"];
  },

  capabilities(): readonly string[] {
    return ["--json", "capabilities"];
  },

  tree(): readonly string[] {
    return ["--json", "--id-format", "uuids", "tree", "--all"];
  },

  listWorkspaces(): readonly string[] {
    return ["--json", "--id-format", "uuids", "list-workspaces"];
  },

  listNotifications(): readonly string[] {
    return ["--json", "--id-format", "uuids", "list-notifications"];
  },

  identifyFocused(): readonly string[] {
    return ["--json", "--id-format", "uuids", "identify", "--no-caller"];
  },

  readScreen(target: CmuxTarget, lines: number): readonly string[] {
    assertTarget(target);
    if (!Number.isInteger(lines) || lines < 1 || lines > CMUX_MAX_PREVIEW_LINES) {
      throw new CmuxError(
        "target-ambiguous",
        `Preview lines must be an integer between 1 and ${CMUX_MAX_PREVIEW_LINES}.`
      );
    }
    return [
      "--id-format",
      "uuids",
      "read-screen",
      "--workspace",
      target.workspaceId,
      "--surface",
      target.surfaceId,
      "--lines",
      String(lines)
    ];
  },

  focusPanel(target: CmuxTarget): readonly string[] {
    assertTarget(target);
    return [
      "focus-panel",
      "--panel",
      target.surfaceId,
      "--workspace",
      target.workspaceId
    ];
  }
};
