import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { clearTimeout as cancelTimer, setTimeout as startTimer } from "node:timers";
import { PRODUCT_NAME } from "../identity";
import { canonicalUuidEquals } from "../security/identifiers";
import { CliCmuxTransport } from "./CliCmuxTransport";
import type { CmuxTransport, PreviewRequest } from "./CmuxTransport";
import {
  CmuxError,
  type CmuxAgentRecord,
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

  agents(signal?: AbortSignal): Promise<CmuxAgentRecord[] | null> {
    return this.transport.agents?.(signal) ?? Promise.resolve(null);
  }

  async readPreview(target: CmuxTarget, request: PreviewRequest): Promise<CmuxPreview> {
    const preview = await this.transport.readPreview(target, request);
    if (!sameTarget(preview, target)) {
      throw new CmuxError(
        "malformed-output",
        "cmux returned terminal output for a different surface."
      );
    }
    return preview;
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
        `cmux window count changed unexpectedly during focus. ${PRODUCT_NAME} will not attempt a cleanup.`
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
    canonicalUuidEquals(left.workspaceId, right.workspaceId) &&
    canonicalUuidEquals(left.paneId, right.paneId) &&
    canonicalUuidEquals(left.surfaceId, right.surfaceId)
  );
}

function boundedDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CmuxError("aborted", "The cmux focus verification was cancelled."));
  return new Promise((resolve, reject) => {
    const timeout = startTimer(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      cancelTimer(timeout);
      reject(new CmuxError("aborted", "The cmux focus verification was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function resolveTarget(snapshot: CmuxSnapshot, target: CmuxTarget): CmuxResolvedTarget {
  const matches: CmuxResolvedTarget[] = [];
  for (const window of snapshot.windows) {
    for (const workspace of window.workspaces) {
      if (!canonicalUuidEquals(workspace.id, target.workspaceId)) continue;
      for (const pane of workspace.panes) {
        if (!canonicalUuidEquals(pane.id, target.paneId)) continue;
        for (const surface of pane.surfaces) {
          if (!canonicalUuidEquals(surface.id, target.surfaceId)) continue;
          matches.push({
            workspaceId: workspace.id,
            paneId: pane.id,
            surfaceId: surface.id,
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
  throw new CmuxError("binary-invalid", `${PRODUCT_NAME} could not find the cmux executable.`);
}
