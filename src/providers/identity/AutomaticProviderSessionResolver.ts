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
  kind: "resolved";
  process: ProviderProcess;
  mapping: AutomaticProviderSessionMapping;
  lifecycle: AutomaticLifecycleObservation | null;
  claudeSession: { sessionId: string; cwd: string } | null;
  codexWriterIds: readonly string[] | null;
}

interface RejectedProcessIdentity {
  kind: "rejected";
  rejectedSurfaceId: string;
  rejectedProviderSessionKeys: readonly string[];
}

type ProcessIdentityAttempt = ProcessResolution | RejectedProcessIdentity | null;

interface ProcessRevalidation {
  resolutions: ProcessResolution[];
  rejectedSurfaceIds: ReadonlySet<string>;
  rejectedProviderSessionKeys: ReadonlySet<string>;
}

interface CandidateSelection {
  candidates: ProcessCandidate[];
  rejectedSurfaceIds: Set<string>;
}

interface NormalizedMappings {
  mappings: AutomaticProviderSessionMapping[];
  rejectedSurfaceIds: ReadonlySet<string>;
  rejectedProviderSessionKeys: ReadonlySet<string>;
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
    const localResolution =
      this.platform === "darwin"
        ? await this.resolveLocalProcesses(surfaces, checkedAt, verifyExact, signal, issues)
        : {
            resolutions: [],
            rejectedSurfaceIds: new Set<string>(),
            rejectedProviderSessionKeys: new Set<string>()
          };
    const processResolutions = localResolution.resolutions;
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
    const processRevalidation = await this.revalidateProcessIdentities(
      processResolutions,
      signal
    );
    if (this.disposed || signal?.aborted) return emptyResolution(checkedAt);
    const rejectedSurfaceIds = new Set([
      ...localResolution.rejectedSurfaceIds,
      ...processRevalidation.rejectedSurfaceIds
    ]);
    const rejectedProviderSessionKeys = new Set([
      ...localResolution.rejectedProviderSessionKeys,
      ...processRevalidation.rejectedProviderSessionKeys
    ]);
    const survivingProcessMappings = processRevalidation.resolutions.map(
      (resolution) => resolution.mapping
    );
    const survivingProcessSurfaceIds = new Set(
      survivingProcessMappings.map((mapping) => mapping.surfaceId)
    );
    const publishableNativeMappings = nativeMappings.filter(
      (mapping) => !survivingProcessSurfaceIds.has(mapping.surfaceId)
    );
    const normalizedMappings = normalizeMappings(
      [
        ...publishableNativeMappings,
        ...survivingProcessMappings
      ],
      issues
    );
    for (const surfaceId of normalizedMappings.rejectedSurfaceIds) {
      rejectedSurfaceIds.add(surfaceId);
    }
    for (const identityKey of normalizedMappings.rejectedProviderSessionKeys) {
      rejectedProviderSessionKeys.add(identityKey);
    }
    for (const mapping of normalizedMappings.mappings) {
      if (rejectedSurfaceIds.has(mapping.surfaceId)) {
        rejectedProviderSessionKeys.add(providerIdentityKey(mapping));
      }
    }
    for (const mapping of normalizedMappings.mappings) {
      if (rejectedProviderSessionKeys.has(providerIdentityKey(mapping))) {
        rejectedSurfaceIds.add(mapping.surfaceId);
      }
    }
    const mappings = normalizedMappings.mappings.filter(
      (mapping) => !rejectedSurfaceIds.has(mapping.surfaceId)
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
    const localLifecycle = processRevalidation.resolutions.flatMap((resolution) =>
      resolution.lifecycle &&
      !rejectedSurfaceIds.has(normalizeCanonicalUuid(resolution.lifecycle.surfaceId)!) &&
      !nativeSurfaceIds.has(normalizeCanonicalUuid(resolution.lifecycle.surfaceId)!)
        ? [resolution.lifecycle]
        : []
    );

    return {
      mappings,
      lifecycle: [...nativeLifecycle, ...localLifecycle],
      suppressedSurfaceIds: [...rejectedSurfaceIds].sort(),
      suppressedProviderSessionKeys: [...rejectedProviderSessionKeys].sort(),
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
  ): Promise<ProcessRevalidation> {
    let before: ProviderProcess[];
    try {
      before = await this.processes.listForegroundProviderProcesses(signal);
    } catch {
      issues.push("The local provider process inventory could not be read.");
      return {
        resolutions: [],
        rejectedSurfaceIds: new Set(),
        rejectedProviderSessionKeys: new Set()
      };
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
    const selection = selectUnambiguousCandidates(candidates.filter(isPresent));
    const attempts = await mapLimited(
      selection.candidates,
      RESOLUTION_CONCURRENCY,
      async (candidate) => {
        try {
          return await this.resolveProcessCandidate(candidate, checkedAt, verifyExact, signal);
        } catch {
          return null;
        }
      }
    );
    const rejectedProviderSessionKeys = new Set<string>();
    for (const attempt of attempts) {
      if (!isRejectedProcessIdentity(attempt)) continue;
      selection.rejectedSurfaceIds.add(attempt.rejectedSurfaceId);
      for (const identityKey of attempt.rejectedProviderSessionKeys) {
        rejectedProviderSessionKeys.add(identityKey);
      }
    }
    const tentative = attempts.filter(isProcessResolution);

    let after: ProviderProcess[];
    try {
      after = await this.processes.listForegroundProviderProcesses(signal);
    } catch {
      issues.push("Provider processes changed while identities were being resolved.");
      for (const resolution of tentative) {
        selection.rejectedSurfaceIds.add(resolution.mapping.surfaceId);
        rejectedProviderSessionKeys.add(providerIdentityKey(resolution.mapping));
      }
      return {
        resolutions: [],
        rejectedSurfaceIds: selection.rejectedSurfaceIds,
        rejectedProviderSessionKeys
      };
    }
    const stable = new Map(after.map((processRecord) => [processRecord.pid, processRecord]));
    const resolutions = tentative.filter((resolution) => {
      const processStable = sameProcess(
        resolution.process,
        stable.get(resolution.process.pid)
      );
      if (!processStable) {
        selection.rejectedSurfaceIds.add(resolution.mapping.surfaceId);
        rejectedProviderSessionKeys.add(providerIdentityKey(resolution.mapping));
      }
      return processStable;
    });
    return {
      resolutions,
      rejectedSurfaceIds: selection.rejectedSurfaceIds,
      rejectedProviderSessionKeys
    };
  }

  private async resolveProcessCandidate(
    candidate: ProcessCandidate,
    checkedAt: number,
    verifyExact: ExactMetadataReader,
    signal?: AbortSignal
  ): Promise<ProcessIdentityAttempt> {
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
        kind: "resolved",
        process: candidate.process,
        mapping,
        lifecycle: claudeLifecycleObservation(
          session.status,
          candidate.surface,
          providerSessionId,
          checkedAt
        ),
        claudeSession: { sessionId: providerSessionId, cwd },
        codexWriterIds: null
      };
    }

    const writerIds = await this.processes.readCodexWriterSessionIds(candidate.process.pid, signal);
    if (writerIds.length === 0) return null;
    const rejection: RejectedProcessIdentity = {
      kind: "rejected",
      rejectedSurfaceId: candidate.surface.surfaceId,
      rejectedProviderSessionKeys: canonicalProviderSessionKeys("codex", writerIds)
    };
    if (writerIds.length > MAX_CODEX_WRITER_LOCKS) return rejection;
    const writerThreads = new Map<string, ProviderSessionMetadata>();
    for (const sessionId of writerIds) {
      if (signal?.aborted || this.disposed) return null;
      const normalizedWriterId = normalizeCanonicalUuid(sessionId);
      if (normalizedWriterId === null || writerThreads.has(normalizedWriterId)) return rejection;
      let thread: ProviderSessionMetadata | null;
      try {
        thread = await verifyExact("codex", sessionId, cwd, signal);
      } catch {
        return signal?.aborted || this.disposed ? null : rejection;
      }
      if (signal?.aborted || this.disposed) return null;
      if (thread === null || !canonicalUuidEquals(thread.sessionId, sessionId)) return rejection;
      writerThreads.set(normalizedWriterId, thread);
    }
    const thread = singleConnectedCodexRoot(writerThreads);
    if (thread === null) return rejection;
    return {
      kind: "resolved",
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
      lifecycle: null,
      claudeSession: null,
      codexWriterIds: [...writerThreads.keys()]
    };
  }

  private async revalidateProcessIdentities(
    resolutions: readonly ProcessResolution[],
    signal?: AbortSignal
  ): Promise<ProcessRevalidation> {
    const rejectedSurfaceIds = new Set<string>();
    const rejectedProviderSessionKeys = new Set<string>();
    if (resolutions.length === 0) {
      return { resolutions: [], rejectedSurfaceIds, rejectedProviderSessionKeys };
    }

    let currentProcesses: ProviderProcess[];
    try {
      currentProcesses = await this.processes.listForegroundProviderProcesses(signal);
    } catch {
      for (const resolution of resolutions) {
        rejectedSurfaceIds.add(resolution.mapping.surfaceId);
        rejectedProviderSessionKeys.add(providerIdentityKey(resolution.mapping));
      }
      return { resolutions: [], rejectedSurfaceIds, rejectedProviderSessionKeys };
    }
    const currentByPid = new Map(
      currentProcesses.map((processRecord) => [processRecord.pid, processRecord])
    );
    const processStableResolutions = resolutions.filter((resolution) => {
      const stable = sameProcess(
        resolution.process,
        currentByPid.get(resolution.process.pid)
      );
      if (!stable) {
        rejectedSurfaceIds.add(resolution.mapping.surfaceId);
        rejectedProviderSessionKeys.add(providerIdentityKey(resolution.mapping));
      }
      return stable;
    });

    const checks = await mapLimited(
      processStableResolutions,
      RESOLUTION_CONCURRENCY,
      async (resolution) => {
        if (resolution.claudeSession !== null) {
          if (signal?.aborted || this.disposed) {
            return {
              resolution: null,
              rejectedSurfaceId: resolution.mapping.surfaceId,
              rejectedProviderSessionKeys: []
            };
          }
          let currentSession;
          try {
            currentSession = await this.processes.readClaudeSession(
              resolution.process,
              resolution.claudeSession.cwd,
              signal
            );
          } catch {
            return {
              resolution: null,
              rejectedSurfaceId: resolution.mapping.surfaceId,
              rejectedProviderSessionKeys: []
            };
          }
          const currentSessionId = normalizeCanonicalUuid(currentSession?.sessionId ?? "");
          if (
            signal?.aborted ||
            this.disposed ||
            currentSession === null ||
            currentSession.cwd !== resolution.claudeSession.cwd ||
            currentSessionId !== resolution.claudeSession.sessionId
          ) {
            return {
              resolution: null,
              rejectedSurfaceId: resolution.mapping.surfaceId,
              rejectedProviderSessionKeys:
                currentSessionId === null ? [] : [`claude:${currentSessionId}`]
            };
          }
          return {
            resolution: {
              ...resolution,
              lifecycle: claudeLifecycleObservation(
                currentSession.status,
                {
                  workspaceId: resolution.mapping.workspaceId,
                  paneId: resolution.mapping.paneId,
                  surfaceId: resolution.mapping.surfaceId,
                  currentDirectory: resolution.claudeSession.cwd
                },
                resolution.claudeSession.sessionId,
                resolution.mapping.observedAt
              )
            },
            rejectedSurfaceId: null,
            rejectedProviderSessionKeys: []
          };
        }
        if (resolution.codexWriterIds === null) {
          return { resolution, rejectedSurfaceId: null, rejectedProviderSessionKeys: [] };
        }
        if (signal?.aborted || this.disposed) {
          return {
            resolution: null,
            rejectedSurfaceId: resolution.mapping.surfaceId,
            rejectedProviderSessionKeys: []
          };
        }
        let currentWriterIds: string[];
        try {
          currentWriterIds = await this.processes.readCodexWriterSessionIds(
            resolution.process.pid,
            signal
          );
        } catch {
          return {
            resolution: null,
            rejectedSurfaceId: resolution.mapping.surfaceId,
            rejectedProviderSessionKeys: []
          };
        }
        const observedProviderSessionKeys = canonicalProviderSessionKeys(
          "codex",
          currentWriterIds
        );
        if (
          signal?.aborted ||
          this.disposed ||
          !sameCanonicalWriterSet(resolution.codexWriterIds, currentWriterIds)
        ) {
          return {
            resolution: null,
            rejectedSurfaceId: resolution.mapping.surfaceId,
            rejectedProviderSessionKeys: observedProviderSessionKeys
          };
        }
        return { resolution, rejectedSurfaceId: null, rejectedProviderSessionKeys: [] };
      }
    );
    for (const [index, { rejectedSurfaceId, rejectedProviderSessionKeys: observedKeys }] of checks.entries()) {
      if (rejectedSurfaceId === null) continue;
      rejectedSurfaceIds.add(rejectedSurfaceId);
      rejectedProviderSessionKeys.add(
        providerIdentityKey(processStableResolutions[index]!.mapping)
      );
      for (const identityKey of observedKeys) {
        rejectedProviderSessionKeys.add(identityKey);
      }
    }
    return {
      resolutions: checks.flatMap(({ resolution }) =>
        resolution === null ? [] : [resolution]
      ),
      rejectedSurfaceIds,
      rejectedProviderSessionKeys
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

function sameCanonicalWriterSet(
  expectedIds: Iterable<string>,
  observedIds: readonly string[]
): boolean {
  if (observedIds.length > MAX_CODEX_WRITER_LOCKS) return false;
  const expected = new Set(expectedIds);
  const observed = new Set<string>();
  for (const observedId of observedIds) {
    const canonicalId = normalizeCanonicalUuid(observedId);
    if (canonicalId === null || observed.has(canonicalId)) return false;
    observed.add(canonicalId);
  }
  return (
    expected.size === observed.size &&
    [...expected].every((expectedId) => observed.has(expectedId))
  );
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

function selectUnambiguousCandidates(
  candidates: readonly ProcessCandidate[]
): CandidateSelection {
  const bySurface = new Map<string, ProcessCandidate[]>();
  for (const candidate of candidates) {
    const list = bySurface.get(candidate.surface.surfaceId) ?? [];
    list.push(candidate);
    bySurface.set(candidate.surface.surfaceId, list);
  }
  const rejectedSurfaceIds = new Set<string>();
  const selected = [...bySurface.entries()].flatMap(([surfaceId, items]) => {
    if (items.length === 1) return items;
    rejectedSurfaceIds.add(surfaceId);
    return [];
  });
  return { candidates: selected, rejectedSurfaceIds };
}

function normalizeMappings(
  mappings: readonly AutomaticProviderSessionMapping[],
  issues: string[]
): NormalizedMappings {
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
  const rejectedSurfaceIds = new Set(ambiguousSurfaces);
  const rejectedProviderSessionKeys = new Set<string>();
  for (const mapping of normalized) {
    const identity = `${mapping.provider}:${mapping.providerSessionId}`;
    if (
      ambiguousSurfaces.has(mapping.surfaceId) ||
      ambiguousIdentities.has(identity)
    ) {
      rejectedSurfaceIds.add(mapping.surfaceId);
      rejectedProviderSessionKeys.add(identity);
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
  return {
    mappings: [...bySurface.values()],
    rejectedSurfaceIds,
    rejectedProviderSessionKeys
  };
}

function providerIdentityKey(
  mapping: Pick<AutomaticProviderSessionMapping, "provider" | "providerSessionId">
): string {
  const providerSessionId = normalizeCanonicalUuid(mapping.providerSessionId);
  return `${mapping.provider}:${providerSessionId ?? mapping.providerSessionId.toLowerCase()}`;
}

function canonicalProviderSessionKeys(
  provider: ProviderSessionKind,
  sessionIds: readonly string[]
): string[] {
  return [
    ...new Set(
      sessionIds.flatMap((sessionId) => {
        const normalized = normalizeCanonicalUuid(sessionId);
        return normalized === null ? [] : [`${provider}:${normalized}`];
      })
    )
  ].sort();
}

function isRejectedProcessIdentity(
  attempt: ProcessIdentityAttempt
): attempt is RejectedProcessIdentity {
  return attempt?.kind === "rejected";
}

function isProcessResolution(attempt: ProcessIdentityAttempt): attempt is ProcessResolution {
  return attempt?.kind === "resolved";
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
    suppressedSurfaceIds: [],
    suppressedProviderSessionKeys: [],
    checkedAt,
    nativeLifecycleAvailable: false,
    issues: []
  };
}
