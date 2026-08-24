import path from "node:path";
import { assertTarget } from "../cmux/commandBuilders";
import type { CmuxTarget } from "../cmux/types";
import { isCanonicalUuid } from "../security/identifiers";

export function validateBinarySetting(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!path.isAbsolute(trimmed) || path.basename(trimmed) !== "cmux" || trimmed.includes("\0")) {
    throw new Error("The cmux setting must be an absolute path to an executable named cmux.");
  }
  return trimmed;
}

export function validateFocusTarget(target: CmuxTarget): void {
  assertTarget(target);
  const unique = new Set([target.workspaceId, target.paneId, target.surfaceId]);
  if (unique.size !== 3) throw new Error("Workspace, pane, and surface identities must be distinct.");
}

export function validateBindingIdentity(taskId: string, target: CmuxTarget): void {
  if (!isCanonicalUuid(taskId)) throw new Error("Task ID is not a canonical UUID.");
  validateFocusTarget(target);
}
