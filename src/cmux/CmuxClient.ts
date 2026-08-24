import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { CliCmuxTransport } from "./CliCmuxTransport";
import type { CmuxTransport, PreviewRequest } from "./CmuxTransport";
import {
  CmuxError,
  type CmuxNotification,
  type CmuxPreview,
  type CmuxProbe,
  type CmuxResolvedTarget,
  type CmuxSnapshot,
  type CmuxTarget
} from "./types";

const DEFAULT_CANDIDATES = [
  "/Applications/cmux.app/Contents/Resources/bin/cmux",
  "/opt/homebrew/bin/cmux",
  "/usr/local/bin/cmux"
] as const;
const FOCUS_VERIFICATION_DELAYS_MS = [0, 50, 150, 300] as const;

export interface FocusResult {
  target: CmuxResolvedTarget;
  verified: boolean;
}

export class CmuxClient {
  constructor(private readonly transport: CmuxTransport) {}

  static async create(explicitBinaryPath = ""): Promise<CmuxClient> {
    const binaryPath = await discoverCmuxBinary(explicitBinaryPath);
    return new CmuxClient(new CliCmuxTransport(binaryPath));
  }

  probe(signal?: AbortSignal): Promise<CmuxProbe> {
    return this.transport.probe(signal);
  }

  snapshot(signal?: AbortSignal): Promise<CmuxSnapshot> {
    return this.transport.snapshot(signal);
  }

  notifications(signal?: AbortSignal): Promise<CmuxNotification[]> {
    return this.transport.notifications(signal);
  }

  readPreview(target: CmuxTarget, request: PreviewRequest): Promise<CmuxPreview> {
    return this.transport.readPreview(target, request);
  }

  focusedTarget(signal?: AbortSignal): Promise<CmuxTarget | null> {
    return this.transport.focusedTarget(signal);
  }

  async focusExact(target: CmuxTarget, signal?: AbortSignal): Promise<FocusResult> {
    const before = await this.snapshot(signal);
    resolveTarget(before, target);
    await this.transport.focus(target, signal);
    let focused: CmuxTarget | null = null;
    for (const delayMs of FOCUS_VERIFICATION_DELAYS_MS) {
      if (delayMs > 0) await boundedDelay(delayMs, signal);
      focused = await this.transport.focusedTarget(signal);
      if (sameTarget(focused, target)) break;
    }
    const after = await this.snapshot(signal);
    if (after.windows.length !== before.windows.length) {
      throw new CmuxError(
        "process-failed",
        "cmux window count changed unexpectedly during focus. Agent Cockpit will not attempt a cleanup."
      );
    }
    const selected = resolveTarget(after, target);
    const verified =
      sameTarget(focused, target);
    return { target: selected, verified };
  }

  dispose(): void {
    this.transport.dispose();
  }
}

function sameTarget(left: CmuxTarget | null, right: CmuxTarget): boolean {
  return (
    left !== null &&
    left.workspaceId === right.workspaceId &&
    left.paneId === right.paneId &&
    left.surfaceId === right.surfaceId
  );
}

function boundedDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CmuxError("aborted", "The cmux focus verification was cancelled."));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new CmuxError("aborted", "The cmux focus verification was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function resolveTarget(snapshot: CmuxSnapshot, target: CmuxTarget): CmuxResolvedTarget {
  const matches: CmuxResolvedTarget[] = [];
  for (const window of snapshot.windows) {
    for (const workspace of window.workspaces) {
      if (workspace.id !== target.workspaceId) continue;
      for (const pane of workspace.panes) {
        if (pane.id !== target.paneId) continue;
        for (const surface of pane.surfaces) {
          if (surface.id !== target.surfaceId) continue;
          matches.push({
            ...target,
            workspaceTitle: workspace.title,
            surfaceTitle: surface.title,
            currentDirectory: workspace.currentDirectory
          });
        }
      }
    }
  }
  if (matches.length === 0) {
    throw new CmuxError("target-missing", "The selected cmux surface no longer exists.");
  }
  if (matches.length > 1) {
    throw new CmuxError("target-ambiguous", "The selected cmux identity resolved to more than one surface.");
  }
  return matches[0]!;
}

export async function discoverCmuxBinary(explicitBinaryPath = ""): Promise<string> {
  const candidates = explicitBinaryPath.trim() ? [explicitBinaryPath.trim()] : [...DEFAULT_CANDIDATES];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || path.basename(candidate) !== "cmux") continue;
    try {
      await access(candidate, constants.X_OK);
      const details = await stat(candidate);
      if (!details.isFile()) continue;
      return await realpath(candidate);
    } catch {
      // Continue through the fixed candidate list.
    }
  }
  if (explicitBinaryPath.trim()) {
    throw new CmuxError("binary-invalid", "The configured cmux path is not an executable file named cmux.");
  }
  throw new CmuxError("binary-invalid", "Agent Cockpit could not find the cmux executable.");
}
