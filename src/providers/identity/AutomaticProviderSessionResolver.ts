import type { CmuxClient } from "../../cmux/CmuxClient";
import {
  type CmuxAgentRecord,
  type CmuxAgentSource,
  type CmuxAgentState,
  type CmuxSnapshot,
  type CmuxTarget
} from "../../cmux/types";
import { isCanonicalUuid, normalizeCanonicalUuid } from "../../security/identifiers";
import type { Confidence } from "../../state/types";
import type { ProviderMetadataService } from "../ProviderMetadataService";
import type { ProviderSessionKind, ProviderSessionMetadata } from "../types";
import { MacOsProcessIdentitySource } from "./MacOsProcessIdentitySource";
import type {
  AutomaticLifecycleObservation,
  AutomaticProviderSessionMapping,
  LocalProcessIdentitySource,
  ProviderIdentityResolution,
  ProviderProcess,
  ProviderSessionResolver
} from "./types";

interface IndexedSurface extends CmuxTarget {
  currentDirectory: string | null;
}

interface ProcessCandidate {
  process: ProviderProcess;
  surface: IndexedSurface;
}

interface ProcessResolution {
  process: ProviderProcess;
  mapping: AutomaticProviderSessionMapping;
  lifecycle: AutomaticLifecycleObservation | null;
}

const RESOLUTION_CONCURRENCY = 2;

export class AutomaticProviderSessionResolver implements ProviderSessionResolver {
  private disposed = false;

  constructor(
    private readonly metadata: ProviderMetadataService,
    private readonly processes: LocalProcessIdentitySource = new MacOsProcessIdentitySource(),
    private readonly now: () => number = Date.now,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  async resolve(
    snapshot: CmuxSnapshot,
    client: CmuxClient,
    signal?: AbortSignal
  ): Promise<ProviderIdentityResolution> {
    const checkedAt = this.now();
    if (this.disposed || signal?.aborted) return emptyResolution(checkedAt);
    const surfaces = indexSurfaces(snapshot);
    const issues: string[] = [];

    const nativePromise = this.readNativeAgents(client, signal, issues);
    const processResolutions =
      this.platform === "darwin"
        ? await this.resolveLocalProcesses(surfaces, checkedAt, signal, issues)
        : [];
    const nativeAgents = await nativePromise;
    if (this.disposed || signal?.aborted) return emptyResolution(checkedAt);

    const nativeMappings = await this.resolveNativeMappings(
      nativeAgents.records,
      processResolutions.map((resolution) => resolution.mapping),
      surfaces,
      checkedAt,
      signal,
      issues
    );
    const mappings = normalizeMappings([
      ...nativeMappings,
      ...processResolutions.map((resolution) => resolution.mapping)
    ]);
    const mappingBySurface = new Map(mappings.map((mapping) => [mapping.surfaceId, mapping]));
    const nativeLifecycle = nativeAgents.records.flatMap((record) => {
      const surface = surfaces.get(record.surfaceId);
      if (!surface) return [];
      const mapping = mappingBySurface.get(record.surfaceId);
      return [nativeLifecycleObservation(record, surface, mapping, checkedAt)];
    });
    const nativeSurfaceIds = new Set(nativeLifecycle.map((observation) => observation.surfaceId));
    const localLifecycle = processResolutions.flatMap((resolution) =>
      resolution.lifecycle && !nativeSurfaceIds.has(resolution.lifecycle.surfaceId)
        ? [resolution.lifecycle]
        : []
    );

    return {
      mappings,
      lifecycle: [...nativeLifecycle, ...localLifecycle],
      checkedAt,
      nativeLifecycleAvailable: nativeAgents.available,
      issues: [...new Set(issues)].slice(0, 8)
    };
  }

  dispose(): void {
    this.disposed = true;
    this.processes.dispose();
  }

  private async resolveLocalProcesses(
    surfaces: ReadonlyMap<string, IndexedSurface>,
    checkedAt: number,
    signal: AbortSignal | undefined,
    issues: string[]
  ): Promise<ProcessResolution[]> {
    let before: ProviderProcess[];
    try {
      before = await this.processes.listForegroundProviderProcesses(signal);
    } catch {
      issues.push("The local provider process inventory could not be read.");
      return [];
    }

    const candidates = await mapLimited(before, RESOLUTION_CONCURRENCY, async (processRecord) => {
      try {
        const surfaceId = await this.processes.readSurfaceId(processRecord.pid, signal);
        const surface = surfaceId ? surfaces.get(surfaceId) : undefined;
        return surface ? { process: processRecord, surface } : null;
      } catch {
        return null;
      }
    });
    const unambiguous = unambiguousCandidates(candidates.filter(isPresent));
    const tentative = await mapLimited(
      unambiguous,
      RESOLUTION_CONCURRENCY,
      async (candidate) => {
        try {
          return await this.resolveProcessCandidate(candidate, checkedAt, signal);
        } catch {
          return null;
        }
      }
    );

    let after: ProviderProcess[];
    try {
      after = await this.processes.listForegroundProviderProcesses(signal);
    } catch {
      issues.push("Provider processes changed while identities were being resolved.");
      return [];
    }
    const stable = new Map(after.map((processRecord) => [processRecord.pid, processRecord]));
    return tentative.filter(
      (resolution): resolution is ProcessResolution =>
        resolution !== null && sameProcess(resolution.process, stable.get(resolution.process.pid))
    );
  }

  private async resolveProcessCandidate(
    candidate: ProcessCandidate,
    checkedAt: number,
    signal?: AbortSignal
  ): Promise<ProcessResolution | null> {
    const cwd = candidate.surface.currentDirectory;
    if (!cwd) return null;
    if (candidate.process.provider === "claude") {
      const session = await this.processes.readClaudeSession(candidate.process, cwd, signal);
      if (!session) return null;
      const providerSessionId = normalizeCanonicalUuid(session.sessionId);
      if (providerSessionId === null) return null;
      const mapping: AutomaticProviderSessionMapping = {
        ...candidate.surface,
        provider: "claude",
        providerSessionId,
        matchSource: "claude-process-registry",
        confidence: "high",
        explanation:
          "Matched the foreground Claude process to this exact cmux surface, then verified its PID, UTC start time, CWD, and local session registry entry.",
        observedAt: checkedAt
      };
      return {
        process: candidate.process,
        mapping,
        lifecycle: claudeLifecycleObservation(
          session.status,
          candidate.surface,
          providerSessionId,
          checkedAt
        )
      };
    }

    const writerIds = await this.processes.readCodexWriterSessionIds(candidate.process.pid, signal);
    const rootThreads: ProviderSessionMetadata[] = [];
    for (const sessionId of writerIds) {
      if (signal?.aborted || this.disposed) return null;
      try {
        const thread = await this.metadata.get("codex", sessionId, cwd, signal);
        if (thread?.parentSessionId === null && thread.sourceKind !== "subAgent") rootThreads.push(thread);
      } catch {
        // One unreadable writer lock must not make a different candidate look exact.
      }
    }
    if (rootThreads.length !== 1) return null;
    const thread = rootThreads[0]!;
    return {
      process: candidate.process,
      mapping: {
        ...candidate.surface,
        provider: "codex",
        providerSessionId: thread.sessionId,
        matchSource: "codex-writer-lock",
        confidence: "high",
        explanation:
          "Matched the foreground Codex process to this exact cmux surface and verified its single open root-thread writer lock through Codex app-server metadata.",
        observedAt: checkedAt
      },
      lifecycle: null
    };
  }

  private async resolveNativeMappings(
    records: readonly CmuxAgentRecord[],
    processMappings: readonly AutomaticProviderSessionMapping[],
    surfaces: ReadonlyMap<string, IndexedSurface>,
    checkedAt: number,
    signal: AbortSignal | undefined,
    issues: string[]
  ): Promise<AutomaticProviderSessionMapping[]> {
    const processBySurface = new Map(processMappings.map((mapping) => [mapping.surfaceId, mapping]));
    const candidates = records.filter(
      (record) =>
        record.sessionId !== null &&
        isCanonicalUuid(record.sessionId) &&
        surfaces.get(record.surfaceId)?.currentDirectory !== null
    );
    return (
      await mapLimited(candidates, RESOLUTION_CONCURRENCY, async (record) => {
        const surface = surfaces.get(record.surfaceId);
        if (!surface?.currentDirectory || !record.sessionId) return null;
        const providerSessionId = normalizeCanonicalUuid(record.sessionId);
        if (providerSessionId === null) return null;
        const processMapping = processBySurface.get(record.surfaceId);
        if (processMapping && processMapping.providerSessionId !== providerSessionId) return null;
        let provider: ProviderSessionKind | null =
          processMapping?.providerSessionId === providerSessionId ? processMapping.provider : null;
        if (!provider) {
          provider = await this.identifyNativeProvider(providerSessionId, surface.currentDirectory, signal);
        }
        if (!provider) return null;
        return {
          ...surface,
          provider,
          providerSessionId,
          matchSource: "cmux-agent-registry" as const,
          confidence: confidenceForNativeSource(record.source),
          explanation: `cmux reported this canonical provider session ID for the exact surface via its ${record.source} agent source.`,
          observedAt: checkedAt
        };
      })
    ).filter(isPresent);
  }

  private async identifyNativeProvider(
    sessionId: string,
    cwd: string,
    signal?: AbortSignal
  ): Promise<ProviderSessionKind | null> {
    if (signal?.aborted || this.disposed) return null;
    try {
      if (await this.metadata.get("claude", sessionId, cwd, signal)) return "claude";
    } catch {
      // Try the other provider; exact metadata is required before assigning a provider.
    }
    if (signal?.aborted || this.disposed) return null;
    try {
      if (await this.metadata.get("codex", sessionId, cwd, signal)) return "codex";
    } catch {
      // Leave the provider unresolved when neither source proves ownership.
    }
    return null;
  }

  private async readNativeAgents(
    client: CmuxClient,
    signal: AbortSignal | undefined,
    issues: string[]
  ): Promise<{ records: CmuxAgentRecord[]; available: boolean }> {
    try {
      const records = await client.agents(signal);
      return records === null ? { records: [], available: false } : { records, available: true };
    } catch {
      issues.push("cmux agent lifecycle metadata could not be read on this refresh.");
      return { records: [], available: false };
    }
  }
}

function indexSurfaces(snapshot: CmuxSnapshot): Map<string, IndexedSurface> {
  const surfaces = new Map<string, IndexedSurface>();
  for (const window of snapshot.windows) {
    for (const workspace of window.workspaces) {
      for (const pane of workspace.panes) {
        for (const surface of pane.surfaces) {
          surfaces.set(surface.id, {
            workspaceId: workspace.id,
            paneId: pane.id,
            surfaceId: surface.id,
            currentDirectory: workspace.currentDirectory
          });
        }
      }
    }
  }
  return surfaces;
}

function unambiguousCandidates(candidates: readonly ProcessCandidate[]): ProcessCandidate[] {
  const bySurface = new Map<string, ProcessCandidate[]>();
  for (const candidate of candidates) {
    const list = bySurface.get(candidate.surface.surfaceId) ?? [];
    list.push(candidate);
    bySurface.set(candidate.surface.surfaceId, list);
  }
  return [...bySurface.values()].flatMap((items) => (items.length === 1 ? items : []));
}

function normalizeMappings(
  mappings: readonly AutomaticProviderSessionMapping[]
): AutomaticProviderSessionMapping[] {
  const bySurface = new Map<string, AutomaticProviderSessionMapping>();
  const claimedSessions = new Set<string>();
  for (const mapping of mappings) {
    const providerSessionId = normalizeCanonicalUuid(mapping.providerSessionId);
    if (providerSessionId === null) continue;
    const sessionKey = `${mapping.provider}:${providerSessionId}`;
    if (bySurface.has(mapping.surfaceId) || claimedSessions.has(sessionKey)) continue;
    bySurface.set(mapping.surfaceId, { ...mapping, providerSessionId });
    claimedSessions.add(sessionKey);
  }
  return [...bySurface.values()];
}

function nativeLifecycleObservation(
  record: CmuxAgentRecord,
  surface: IndexedSurface,
  mapping: AutomaticProviderSessionMapping | undefined,
  checkedAt: number
): AutomaticLifecycleObservation {
  return {
    ...surface,
    state: record.state,
    source: record.source,
    provider: mapping?.provider ?? "unknown",
    providerSessionId: mapping?.providerSessionId ?? null,
    observedAt: checkedAt,
    occurredAt: record.updatedAt,
    explanation: nativeLifecycleExplanation(record.state, record.source)
  };
}

function claudeLifecycleObservation(
  status: string | null,
  surface: IndexedSurface,
  sessionId: string,
  checkedAt: number
): AutomaticLifecycleObservation | null {
  const state = claudeStatusState(status);
  if (!state) return null;
  return {
    ...surface,
    state,
    source: "claude-registry",
    provider: "claude",
    providerSessionId: sessionId,
    observedAt: checkedAt,
    occurredAt: null,
    explanation: `Claude's PID-bound local session registry reports ${state}.`
  };
}

function claudeStatusState(status: string | null): CmuxAgentState | "failed" | null {
  switch (status?.toLowerCase()) {
    case "running":
    case "working":
      return "working";
    case "blocked":
    case "needs-input":
    case "waiting":
      return "blocked";
    case "idle":
      return "idle";
    case "done":
    case "completed":
      return "done";
    case "error":
    case "failed":
      return "failed";
    default:
      return null;
  }
}

function nativeLifecycleExplanation(state: CmuxAgentState, source: CmuxAgentSource): string {
  const label =
    state === "blocked"
      ? "waiting for input"
      : state === "done"
        ? "finished a turn"
        : state;
  return `cmux reports that this agent is ${label} via its ${source} lifecycle source.`;
}

function confidenceForNativeSource(source: CmuxAgentSource): Confidence {
  return source === "detected" ? "medium" : "high";
}

function sameProcess(left: ProviderProcess, right: ProviderProcess | undefined): boolean {
  return (
    right !== undefined &&
    left.pid === right.pid &&
    left.parentPid === right.parentPid &&
    left.startedAt === right.startedAt &&
    left.executable === right.executable &&
    left.provider === right.provider
  );
}

async function mapLimited<T, R>(
  values: readonly T[],
  limit: number,
  callback: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await callback(values[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), values.length) }, () => worker())
  );
  return results;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function emptyResolution(checkedAt: number): ProviderIdentityResolution {
  return {
    mappings: [],
    lifecycle: [],
    checkedAt,
    nativeLifecycleAvailable: false,
    issues: []
  };
}
