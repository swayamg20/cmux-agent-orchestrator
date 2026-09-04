import { normalizePath } from "obsidian";

/**
 * Returns true when a vault event occurred inside the task folder or changed
 * an ancestor that contains it. The ancestor case covers folder moves and
 * deletions without scanning unrelated vault paths.
 */
export function pathAffectsTaskFolder(eventPath: string, taskFolder: string): boolean {
  const path = normalizePath(eventPath);
  const folder = normalizePath(taskFolder);
  if (!path || !folder) return false;
  return path === folder || path.startsWith(`${folder}/`) || folder.startsWith(`${path}/`);
}
