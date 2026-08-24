export type CmuxAccessMode = "cmuxOnly" | "automation" | "allowAll" | "password" | "unknown";

export interface CmuxCapabilities {
  version: number;
  protocol: string;
  accessMode: CmuxAccessMode;
  methods: ReadonlySet<string>;
}

export interface CmuxProbe {
  binaryPath: string;
  versionText: string;
  capabilities: CmuxCapabilities;
  latencyMs: number;
}

export interface CmuxSurface {
  id: string;
  paneId: string;
  index: number;
  indexInPane: number;
  title: string;
  type: string;
  selected: boolean;
  focused: boolean;
  active: boolean;
}

export interface CmuxPane {
  id: string;
  index: number;
  focused: boolean;
  active: boolean;
  selectedSurfaceId: string | null;
  surfaces: CmuxSurface[];
}

export interface CmuxWorkspace {
  id: string;
  index: number;
  title: string;
  selected: boolean;
  active: boolean;
  pinned: boolean;
  currentDirectory: string | null;
  panes: CmuxPane[];
}

export interface CmuxWindow {
  id: string;
  index: number;
  current: boolean;
  visible: boolean;
  active: boolean;
  selectedWorkspaceId: string | null;
  workspaces: CmuxWorkspace[];
}

export interface CmuxSnapshot {
  observedAt: number;
  windows: CmuxWindow[];
}

export interface CmuxNotification {
  id: string;
  workspaceId: string;
  surfaceId: string;
  title: string;
  subtitle: string;
  body: string;
  isRead: boolean;
}

export interface CmuxPreview {
  workspaceId: string;
  surfaceId: string;
  text: string;
  observedAt: number;
  truncated: boolean;
}

export interface CmuxTarget {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
}

export interface CmuxResolvedTarget extends CmuxTarget {
  workspaceTitle: string;
  surfaceTitle: string;
  currentDirectory: string | null;
}

export type CmuxErrorCode =
  | "aborted"
  | "access-blocked"
  | "binary-invalid"
  | "cmux-not-running"
  | "malformed-output"
  | "output-limit"
  | "process-failed"
  | "target-ambiguous"
  | "target-missing"
  | "timeout"
  | "unsupported";

export class CmuxError extends Error {
  constructor(
    public readonly code: CmuxErrorCode,
    message: string,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = "CmuxError";
  }
}

export function surfaceKey(target: Pick<CmuxTarget, "workspaceId" | "surfaceId">): string {
  return `${target.workspaceId}:${target.surfaceId}`;
}
