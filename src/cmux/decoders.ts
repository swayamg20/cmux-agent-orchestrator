import {
  CmuxError,
  type CmuxAccessMode,
  type CmuxCapabilities,
  type CmuxNotification,
  type CmuxSnapshot,
  type CmuxTarget,
  type CmuxWindow,
  type CmuxWorkspace
} from "./types";
import { isCanonicalUuid } from "../security/identifiers";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CmuxError("malformed-output", `${label} must be an object.`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new CmuxError("malformed-output", `${label} must be an array.`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new CmuxError("malformed-output", `${label} must be a string.`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CmuxError("malformed-output", `${label} must be a finite number.`);
  }
  return value;
}

function boolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function canonicalUuid(value: unknown, label: string): string {
  const decoded = string(value, label);
  if (!isCanonicalUuid(decoded)) throw new CmuxError("malformed-output", `${label} must be a canonical UUID.`);
  return decoded;
}

function nullableCanonicalUuid(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return canonicalUuid(value, label);
}

function uniqueCanonicalUuid(value: unknown, label: string, seen: Set<string>): string {
  const decoded = canonicalUuid(value, label);
  if (seen.has(decoded)) throw new CmuxError("malformed-output", `${label} is duplicated.`);
  seen.add(decoded);
  return decoded;
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  return string(value, label).slice(0, maxLength);
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CmuxError("malformed-output", `${label} was not valid JSON.`, error);
  }
}

function decodeAccessMode(value: unknown): CmuxAccessMode {
  if (value === "cmuxOnly" || value === "automation" || value === "allowAll" || value === "password") {
    return value;
  }
  return "unknown";
}

export function decodeCapabilities(text: string): CmuxCapabilities {
  const root = record(parseJson(text, "cmux capabilities"), "cmux capabilities");
  const methods = array(root.methods, "cmux capabilities.methods").map((method, index) =>
    string(method, `cmux capabilities.methods[${index}]`)
  );
  return {
    version: finiteNumber(root.version, "cmux capabilities.version"),
    protocol: string(root.protocol, "cmux capabilities.protocol"),
    accessMode: decodeAccessMode(root.access_mode),
    methods: new Set(methods)
  };
}

export function decodeWorkspaceDirectories(text: string): Map<string, string | null> {
  const root = record(parseJson(text, "cmux workspace list"), "cmux workspace list");
  const workspaces = array(root.workspaces, "cmux workspace list.workspaces");
  const directories = new Map<string, string | null>();
  for (const [index, rawWorkspace] of workspaces.entries()) {
    const workspace = record(rawWorkspace, `cmux workspace list.workspaces[${index}]`);
    const id = canonicalUuid(workspace.id, `cmux workspace list.workspaces[${index}].id`);
    if (directories.has(id)) throw new CmuxError("malformed-output", `cmux workspace ${id} is duplicated.`);
    const currentDirectory = nullableString(workspace.current_directory);
    directories.set(id, currentDirectory === null ? null : currentDirectory.slice(0, 4_096));
  }
  return directories;
}

export function decodeFocusedTarget(text: string): CmuxTarget | null {
  const root = record(parseJson(text, "cmux identify"), "cmux identify");
  if (root.focused === null || root.focused === undefined) return null;
  const focused = record(root.focused, "cmux identify.focused");
  return {
    workspaceId: canonicalUuid(focused.workspace_id, "cmux identify.focused.workspace_id"),
    paneId: canonicalUuid(focused.pane_id, "cmux identify.focused.pane_id"),
    surfaceId: canonicalUuid(focused.surface_id, "cmux identify.focused.surface_id")
  };
}

export function decodeTree(
  text: string,
  observedAt: number,
  directories: ReadonlyMap<string, string | null> = new Map()
): CmuxSnapshot {
  const root = record(parseJson(text, "cmux tree"), "cmux tree");
  const rawWindows = array(root.windows, "cmux tree.windows");
  const windowIds = new Set<string>();
  const workspaceIds = new Set<string>();
  const paneIds = new Set<string>();
  const surfaceIds = new Set<string>();
  const windows: CmuxWindow[] = rawWindows.map((rawWindow, windowIndex) => {
    const window = record(rawWindow, `cmux tree.windows[${windowIndex}]`);
    const rawWorkspaces = array(window.workspaces, `cmux tree.windows[${windowIndex}].workspaces`);
    const workspaces: CmuxWorkspace[] = rawWorkspaces.map((rawWorkspace, workspaceIndex) => {
      const workspace = record(
        rawWorkspace,
        `cmux tree.windows[${windowIndex}].workspaces[${workspaceIndex}]`
      );
      const workspaceId = uniqueCanonicalUuid(workspace.id, "cmux workspace.id", workspaceIds);
      const rawPanes = array(workspace.panes, `cmux workspace ${workspaceId}.panes`);
      return {
        id: workspaceId,
        index: finiteNumber(workspace.index, `cmux workspace ${workspaceId}.index`),
        title: boundedText(workspace.title, `cmux workspace ${workspaceId}.title`, 512),
        selected: boolean(workspace.selected),
        active: boolean(workspace.active),
        pinned: boolean(workspace.pinned),
        currentDirectory: directories.get(workspaceId) ?? null,
        panes: rawPanes.map((rawPane, paneIndex) => {
          const pane = record(rawPane, `cmux workspace ${workspaceId}.panes[${paneIndex}]`);
          const paneId = uniqueCanonicalUuid(pane.id, "cmux pane.id", paneIds);
          const rawSurfaces = array(pane.surfaces, `cmux pane ${paneId}.surfaces`);
          return {
            id: paneId,
            index: finiteNumber(pane.index, `cmux pane ${paneId}.index`),
            focused: boolean(pane.focused),
            active: boolean(pane.active),
            selectedSurfaceId: nullableCanonicalUuid(pane.selected_surface_id, `cmux pane ${paneId}.selected_surface_id`),
            surfaces: rawSurfaces.map((rawSurface, surfaceIndex) => {
              const surface = record(rawSurface, `cmux pane ${paneId}.surfaces[${surfaceIndex}]`);
              const surfaceId = uniqueCanonicalUuid(surface.id, "cmux surface.id", surfaceIds);
              const declaredPaneId = canonicalUuid(surface.pane_id, "cmux surface.pane_id");
              if (declaredPaneId !== paneId) {
                throw new CmuxError("malformed-output", `cmux surface ${surfaceId} references a different pane.`);
              }
              return {
                id: surfaceId,
                paneId: declaredPaneId,
                index: finiteNumber(surface.index, "cmux surface.index"),
                indexInPane: finiteNumber(surface.index_in_pane, "cmux surface.index_in_pane"),
                title: boundedText(surface.title, "cmux surface.title", 512),
                type: boundedText(surface.type, "cmux surface.type", 64),
                selected: boolean(surface.selected) || boolean(surface.selected_in_pane),
                focused: boolean(surface.focused),
                active: boolean(surface.active)
              };
            })
          };
        })
      };
    });
    return {
      id: uniqueCanonicalUuid(window.id, `cmux tree.windows[${windowIndex}].id`, windowIds),
      index: finiteNumber(window.index, `cmux tree.windows[${windowIndex}].index`),
      current: boolean(window.current),
      visible: boolean(window.visible),
      active: boolean(window.active),
      selectedWorkspaceId: nullableCanonicalUuid(
        window.selected_workspace_id,
        `cmux tree.windows[${windowIndex}].selected_workspace_id`
      ),
      workspaces
    };
  });
  return { observedAt, windows };
}

export function decodeNotifications(text: string): CmuxNotification[] {
  const root = parseJson(text, "cmux notifications");
  const notificationIds = new Set<string>();
  return array(root, "cmux notifications").map((rawNotification, index) => {
    const notification = record(rawNotification, `cmux notifications[${index}]`);
    return {
      id: uniqueCanonicalUuid(notification.id, `cmux notifications[${index}].id`, notificationIds),
      workspaceId: canonicalUuid(notification.workspace_id, `cmux notifications[${index}].workspace_id`),
      surfaceId: canonicalUuid(notification.surface_id, `cmux notifications[${index}].surface_id`),
      title: boundedText(notification.title, `cmux notifications[${index}].title`, 512),
      subtitle: boundedText(notification.subtitle, `cmux notifications[${index}].subtitle`, 1024),
      body: boundedText(notification.body, `cmux notifications[${index}].body`, 4096),
      isRead: boolean(notification.is_read)
    };
  });
}
