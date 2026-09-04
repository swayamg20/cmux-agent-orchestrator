import type { CmuxClient } from "../../cmux/CmuxClient";
import {
  type CmuxAgentRecord,
  type CmuxAgentSource,
  type CmuxAgentState,
  type CmuxSnapshot,
  type CmuxTarget
} from "../../cmux/types";
import {
  canonicalUuidEquals,
  isCanonicalUuid,
  normalizeCanonicalUuid
} from "../../security/identifiers";
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

type ExactMetadataReader = (
  provider: ProviderSessionKind,
  sessionId: string,
  cwd: string,
  signal?: AbortSignal
) => Promise<ProviderSessionMetadata | null>;

const RESOLUTION_CONCURRENCY = 2;
const MAX_CODEX_WRITER_LOCKS = 8;

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
    const verifyExact = memoizeExactMetadataReads(this.metadata);

    const nativePromise = this.readNativeAgents(client, signal, issues);
    const processResolutions =
      this.platform === "darwin"
        ? await this.resolveLocalProcesses(surfaces, checkedAt, verifyExact, signal, issues)
        : [];
    const nativeAgents = await nativePromise;
    if (this.disposed || signal?.aborted) return emptyResolution(checkedAt);

    const nativeMappings = await this.resolveNativeMappings(
      nativeAgents.records,
      processResolutions.map((resolution) => resolution.mapping),
      surfaces,
      checkedAt,
      verifyExact,
      signal,
      issues
    );
    const mappings = normalizeMappings(
      [
        ...nativeMappings,
        ...processResolutions.map((resolution) => resolution.mapping)
      ],
      issues
    );
    const mappingBySurface = new Map(
      mappings.map((mapping) => [normalizeCanonicalUuid(mapping.surfaceId)!, mapping])
    );
    const nativeLifecycle = nativeAgents.records.flatMap((record) => {
      const surfaceId = normalizeCanonicalUuid(record.surfaceId);
      if (surfaceId === null) return [];
      const surface = surfaces.get(surfaceId);
      if (!surface) return [];
      const mapping = mappingBySurface.get(surfaceId);
      const nativeSessionId =
        record.sessionId === null ? null : normalizeCanonicalUuid(record.sessionId);
      if (record.sessionId !== null && nativeSessionId === null) return [];
      if (
        mapping !== undefined &&
        nativeSessionId !== null &&
        mapping.providerSessionId !== nativeSessionId
      ) {
        issues.push("Conflicting cmux lifecycle identity was discarded for safety.");
        return [];
      }
      return [nativeLifecycleObservation(record, surface, mapping, checkedAt)];
    });
    const nativeSurfaceIds = new Set(
      nativeLifecycle.map((observation) => normalizeCanonicalUuid(observation.surfaceId)!)
    );
    const localLifecycle = processResolutions.flatMap((resolution) =>
      resolution.lifecycle &&
      !nativeSurfaceIds.has(normalizeCanonicalUuid(resolution.lifecycle.surfaceId)!)
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
    verifyExact: ExactMetadataReader,
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
        const normalizedSurfaceId = surfaceId ? normalizeCanonicalUuid(surfaceId) : null;
        const surface = normalizedSurfaceId ? surfaces.get(normalizedSurfaceId) : undefined;
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
          return await this.resolveProcessCandidate(candidate, checkedAt, verifyExact, signal);
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
    verifyExact: ExactMetadataReader,
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
    if (writerIds.length > MAX_CODEX_WRITER_LOCKS) return null;
    const writerThreads = new Map<string, ProviderSessionMetadata>();
    for (const sessionId of writerIds) {
      if (signal?.aborted || this.disposed) return null;
      const normalizedWriterId = normalizeCanonicalUuid(sessionId);
      if (normalizedWriterId === null || writerThreads.has(normalizedWriterId)) return null;
      let thread: ProviderSessionMetadata | null;
      try {
        thread = await verifyExact("codex", sessionId, cwd, signal);
      } catch {
        return null;
      }
      if (thread === null || !canonicalUuidEquals(thread.sessionId, sessionId)) return null;
      writerThreads.set(normalizedWriterId, thread);
    }
    const thread = singleConnectedCodexRoot(writerThreads);
    if (thread === null) return null;
    return {
      process: candidate.process,
      mapping: {
        ...candidate.surface,
        provider: "codex",
        providerSessionId: thread.sessionId,
        matchSource: "codex-writer-lock",
        confidence: "high",
        explanation:
          "Matched the foreground Codex process to this exact cmux surface and verified that every open writer lock belongs to its single rooted Codex thread tree.",
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
    verifyExact: ExactMetadataReader,
    signal: AbortSignal | undefined,
    issues: string[]
  ): Promise<AutomaticProviderSessionMapping[]> {
    const processBySurface = new Map(
      processMappings.map((mapping) => [normalizeCanonicalUuid(mapping.surfaceId)!, mapping])
    );
    const candidates = records.filter(
      (record) =>
        record.sessionId !== null &&
        isCanonicalUuid(record.sessionId) &&
        normalizeCanonicalUuid(record.surfaceId) !== null &&
        surfaces.get(normalizeCanonicalUuid(record.surfaceId)!)?.currentDirectory !== null
    );
    return (
      await mapLimited(candidates, RESOLUTION_CONCURRENCY, async (record) => {
        const surfaceId = normalizeCanonicalUuid(record.surfaceId);
        if (surfaceId === null) return null;
        const surface = surfaces.get(surfaceId);
        if (!surface?.currentDirectory || !record.sessionId) return null;
        const providerSessionId = normalizeCanonicalUuid(record.sessionId);
        if (providerSessionId === null) return null;
        const processMapping = processBySurface.get(surfaceId);
        if (processMapping && processMapping.providerSessionId !== providerSessionId) return null;
        let provider: ProviderSessionKind | null =
          processMapping?.providerSessionId === providerSessionId ? processMapping.provider : null;
        if (!provider) {
          provider = await this.identifyNativeProvider(
            providerSessionId,
            surface.currentDirectory,
            verifyExact,
            signal
          );
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
    verifyExact: ExactMetadataReader,
    signal?: AbortSignal
  ): Promise<ProviderSessionKind | null> {
    if (signal?.aborted || this.disposed) return null;
    try {
      if (await verifyExact("claude", sessionId, cwd, signal)) return "claude";
    } catch {
      // Try the other provider; exact metadata is required before assigning a provider.
    }
    if (signal?.aborted || this.disposed) return null;
    try {
      if (await verifyExact("codex", sessionId, cwd, signal)) return "codex";
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

function memoizeExactMetadataReads(metadata: ProviderMetadataService): ExactMetadataReader {
  const reads = new Map<string, Promise<ProviderSessionMetadata | null>>();
  return (provider, sessionId, cwd, signal) => {
    const canonicalSessionId = normalizeCanonicalUuid(sessionId);
    if (canonicalSessionId === null || signal?.aborted) return Promise.resolve(null);
    const key = `${provider}\0${canonicalSessionId}\0${cwd}`;
    const existing = reads.get(key);
    const pending =
      existing ?? metadata.verifyExact(provider, canonicalSessionId, cwd, signal);
    if (!existing) reads.set(key, pending);
    return pending.then((session) =>
      session === null || signal?.aborted ? null : { ...session }
    );
  };
}

function singleConnectedCodexRoot(
  threads: ReadonlyMap<string, ProviderSessionMetadata>
): ProviderSessionMetadata | null {
  const roots = [...threads.entries()].filter(
    ([, thread]) => thread.parentSessionId === null && thread.sourceKind !== "subAgent"
  );
  if (roots.length !== 1) return null;
  const [rootId, root] = roots[0]!;
  const parentByThread = new Map<string, string>();

  for (const [threadId, thread] of threads) {
    if (threadId === rootId) continue;
    const parentId = normalizeCanonicalUuid(thread.parentSessionId ?? "");
    if (
      thread.sourceKind !== "subAgent" ||
      parentId === null ||
      !threads.has(parentId)
    ) {
      return null;
    }
    parentByThread.set(threadId, parentId);
  }

  for (const threadId of parentByThread.keys()) {
    const visited = new Set<string>();
    let currentId = threadId;
    while (currentId !== rootId) {
      if (visited.has(currentId)) return null;
      visited.add(currentId);
      const parentId = parentByThread.get(currentId);
      if (parentId === undefined) return null;
      currentId = parentId;
    }
  }

  return root;
}

function indexSurfaces(snapshot: CmuxSnapshot): Map<string, IndexedSurface> {
  const surfaces = new Map<string, IndexedSurface>();
  for (const window of snapshot.windows) {
    for (const workspace of window.workspaces) {
      for (const pane of workspace.panes) {
        for (const surface of pane.surfaces) {
          const workspaceId = normalizeCanonicalUuid(workspace.id);
          const paneId = normalizeCanonicalUuid(pane.id);
          const surfaceId = normalizeCanonicalUuid(surface.id);
          if (workspaceId === null || paneId === null || surfaceId === null) continue;
          surfaces.set(surfaceId, {
            workspaceId,
            paneId,
            surfaceId,
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
  mappings: readonly AutomaticProviderSessionMapping[],
  issues: string[]
): AutomaticProviderSessionMapping[] {
  const normalized = mappings.flatMap((mapping) => {
    const workspaceId = normalizeCanonicalUuid(mapping.workspaceId);
    const paneId = normalizeCanonicalUuid(mapping.paneId);
    const surfaceId = normalizeCanonicalUuid(mapping.surfaceId);
    const providerSessionId = normalizeCanonicalUuid(mapping.providerSessionId);
    return workspaceId === null || paneId === null || surfaceId === null || providerSessionId === null
      ? []
      : [{ ...mapping, workspaceId, paneId, surfaceId, providerSessionId }];
  });
  const identitiesBySurface = new Map<string, Set<string>>();
  const surfacesByIdentity = new Map<string, Set<string>>();
  for (const mapping of normalized) {
    const identity = `${mapping.provider}:${mapping.providerSessionId}`;
    const surfaceIdentities = identitiesBySurface.get(mapping.surfaceId) ?? new Set<string>();
    surfaceIdentities.add(identity);
    identitiesBySurface.set(mapping.surfaceId, surfaceIdentities);
    const identitySurfaces = surfacesByIdentity.get(identity) ?? new Set<string>();
    identitySurfaces.add(mapping.surfaceId);
    surfacesByIdentity.set(identity, identitySurfaces);
  }

  const ambiguousSurfaces = new Set(
    [...identitiesBySurface].filter(([, identities]) => identities.size > 1).map(([surfaceId]) => surfaceId)
  );
  const ambiguousIdentities = new Set(
    [...surfacesByIdentity].filter(([, surfaces]) => surfaces.size > 1).map(([identity]) => identity)
  );
  if (ambiguousSurfaces.size > 0 || ambiguousIdentities.size > 0) {
    issues.push("Conflicting provider conversation identities were discarded for safety.");
  }

  const bySurface = new Map<string, AutomaticProviderSessionMapping>();
  for (const mapping of normalized) {
    const identity = `${mapping.provider}:${mapping.providerSessionId}`;
    if (
      ambiguousSurfaces.has(mapping.surfaceId) ||
      ambiguousIdentities.has(identity)
    ) {
      continue;
    }
    const existing = bySurface.get(mapping.surfaceId);
    if (
      existing === undefined ||
      confidenceRank(mapping.confidence) > confidenceRank(existing.confidence)
    ) {
      bySurface.set(mapping.surfaceId, mapping);
    }
  }
  return [...bySurface.values()];
}

function confidenceRank(confidence: Confidence): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
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
