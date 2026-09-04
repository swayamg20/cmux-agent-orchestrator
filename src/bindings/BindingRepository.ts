import { createHash, randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { isDeepStrictEqual } from "node:util";
import type { Plugin } from "obsidian";
import { PRODUCT_NAME } from "../identity";
import { isCanonicalUuid, normalizeCanonicalUuid } from "../security/identifiers";
import { parseSettings, type AgentCockpitSettings } from "../settings/AgentCockpitSettings";
import type {
  AgentRunRecord,
  AttachBindingResult,
  BindingRecord,
  MachineBindings,
  NewBindingRecord,
  ProviderSessionMapping,
  RelocateBindingInput,
  RunRelation
} from "./types";
import { loadLegacyPluginData } from "./LegacyDataImporter";

const MAX_MACHINES = 100;
const MAX_BINDINGS_PER_MACHINE = 5_000;
const MAX_RUNS_PER_MACHINE = 20_000;
const MAX_PROVIDER_SESSIONS_PER_MACHINE = 5_000;
const MACHINE_ID_PATTERN = /^[0-9a-f]{20}$/;

interface PersistedPluginData {
  schemaVersion: 3;
  settings: AgentCockpitSettings;
  machines: Record<string, MachineBindings>;
}

function machineId(): string {
  let user = "unknown";
  try {
    user = userInfo().username;
  } catch {
    // The hash remains machine-local even when username lookup is unavailable.
  }
  return createHash("sha256").update(`${hostname()}\0${user}`).digest("hex").slice(0, 20);
}

function validProvider(value: unknown): value is BindingRecord["provider"] {
  return value === "claude" || value === "codex" || value === "shell" || value === "unknown";
}

function validProviderSessionId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 256);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isLegacyBinding(value: unknown): value is NewBindingRecord {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.taskId === "string" && isCanonicalUuid(raw.taskId) &&
    typeof raw.workspaceId === "string" && isCanonicalUuid(raw.workspaceId) &&
    typeof raw.paneId === "string" && isCanonicalUuid(raw.paneId) &&
    typeof raw.surfaceId === "string" && isCanonicalUuid(raw.surfaceId) &&
    validProvider(raw.provider) &&
    validProviderSessionId(raw.providerSessionId) &&
    validDate(raw.attachedAt)
  );
}

function isBinding(value: unknown): value is BindingRecord {
  if (!isLegacyBinding(value)) return false;
  const raw = value as unknown as Record<string, unknown>;
  return (
    typeof raw.bindingId === "string" && isCanonicalUuid(raw.bindingId) &&
    typeof raw.runId === "string" && isCanonicalUuid(raw.runId)
  );
}

function validRelation(value: unknown): value is RunRelation {
  return value === "initial" || value === "resume" || value === "fork" || value === "handoff" || value === "unknown";
}

function isRun(value: unknown): value is AgentRunRecord {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.runId === "string" && isCanonicalUuid(raw.runId) &&
    typeof raw.taskId === "string" && isCanonicalUuid(raw.taskId) &&
    validProvider(raw.provider) &&
    validProviderSessionId(raw.providerSessionId) &&
    validRelation(raw.relation) &&
    (raw.parentRunId === null || (typeof raw.parentRunId === "string" && isCanonicalUuid(raw.parentRunId))) &&
    validDate(raw.firstAttachedAt) &&
    validDate(raw.lastAttachedAt)
  );
}

function isProviderSessionMapping(value: unknown): value is ProviderSessionMapping {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.workspaceId === "string" && isCanonicalUuid(raw.workspaceId) &&
    typeof raw.paneId === "string" && isCanonicalUuid(raw.paneId) &&
    typeof raw.surfaceId === "string" && isCanonicalUuid(raw.surfaceId) &&
    (raw.provider === "claude" || raw.provider === "codex") &&
    typeof raw.providerSessionId === "string" && isCanonicalUuid(raw.providerSessionId) &&
    validDate(raw.matchedAt)
  );
}

function normalizeNewBindingRecord(binding: NewBindingRecord): NewBindingRecord {
  return {
    ...binding,
    taskId: normalizeCanonicalUuid(binding.taskId)!,
    workspaceId: normalizeCanonicalUuid(binding.workspaceId)!,
    paneId: normalizeCanonicalUuid(binding.paneId)!,
    surfaceId: normalizeCanonicalUuid(binding.surfaceId)!,
    providerSessionId: normalizeProviderSessionId(binding.providerSessionId)
  };
}

function normalizeBindingRecord(binding: BindingRecord): BindingRecord {
  return {
    ...normalizeNewBindingRecord(binding),
    bindingId: normalizeCanonicalUuid(binding.bindingId)!,
    runId: normalizeCanonicalUuid(binding.runId)!
  };
}

function normalizeRunRecord(run: AgentRunRecord): AgentRunRecord {
  return {
    ...run,
    runId: normalizeCanonicalUuid(run.runId)!,
    taskId: normalizeCanonicalUuid(run.taskId)!,
    providerSessionId: normalizeProviderSessionId(run.providerSessionId),
    parentRunId: run.parentRunId === null ? null : normalizeCanonicalUuid(run.parentRunId)!
  };
}

function normalizeProviderSessionMapping(
  mapping: ProviderSessionMapping
): ProviderSessionMapping {
  return {
    ...mapping,
    workspaceId: normalizeCanonicalUuid(mapping.workspaceId)!,
    paneId: normalizeCanonicalUuid(mapping.paneId)!,
    surfaceId: normalizeCanonicalUuid(mapping.surfaceId)!,
    providerSessionId: normalizeCanonicalUuid(mapping.providerSessionId)!
  };
}

function decodeMachine(value: unknown, id: string): MachineBindings {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const rawBindings = Array.isArray(raw.bindings) ? raw.bindings : [];
  const bindingCandidates: BindingRecord[] = [];
  const migratedRunsById = new Map<string, AgentRunRecord>();
  for (const candidate of rawBindings.slice(0, MAX_BINDINGS_PER_MACHINE)) {
    let binding: BindingRecord | null = null;
    if (isBinding(candidate)) {
      binding = normalizeBindingRecord(candidate);
    }
    else if (isLegacyBinding(candidate)) {
      const normalized = normalizeNewBindingRecord(candidate);
      const runId = stableUuid(`run\0${id}\0${normalized.taskId}\0${normalized.surfaceId}\0${normalized.attachedAt}`);
      binding = {
        ...normalized,
        bindingId: stableUuid(`binding\0${id}\0${normalized.workspaceId}\0${normalized.surfaceId}\0${normalized.attachedAt}`),
        runId
      };
      migratedRunsById.set(runId, {
        runId,
        taskId: normalized.taskId,
        provider: normalized.provider,
        providerSessionId: normalized.providerSessionId,
        relation: "unknown",
        parentRunId: null,
        firstAttachedAt: normalized.attachedAt,
        lastAttachedAt: normalized.attachedAt
      });
    }
    if (binding) bindingCandidates.push(binding);
    if (bindingCandidates.length >= MAX_BINDINGS_PER_MACHINE) break;
  }
  const decodedBindings = unambiguousBindings(bindingCandidates);

  const runCandidates: AgentRunRecord[] = [];
  if (Array.isArray(raw.runs)) {
    for (const candidate of raw.runs.slice(0, MAX_RUNS_PER_MACHINE)) {
      if (isRun(candidate)) {
        runCandidates.push(normalizeRunRecord(candidate));
      }
      if (runCandidates.length >= MAX_RUNS_PER_MACHINE) break;
    }
  }
  const retainedBindingRunIds = new Set(decodedBindings.map((binding) => binding.runId));
  for (const [runId, run] of migratedRunsById) {
    if (runCandidates.length >= MAX_RUNS_PER_MACHINE) break;
    if (retainedBindingRunIds.has(runId)) runCandidates.push(run);
  }
  const runs = unambiguousRuns(runCandidates);
  const runsById = new Map(runs.map((run) => [run.runId, run] as const));
  const bindings = decodedBindings.filter((binding) => {
    const run = runsById.get(binding.runId);
    return run !== undefined && bindingMatchesRun(binding, run);
  });
  const providerSessions = decodeProviderSessions(raw.providerSessions);
  return {
    bindings,
    runs,
    providerSessions
  };
}

function unambiguousBindings(candidates: BindingRecord[]): BindingRecord[] {
  return retainUnambiguousRecords(
    candidates,
    bindingFingerprint,
    (binding) => {
      const identities = [
        `surface:${binding.surfaceId}`,
        `binding:${binding.bindingId}`,
        `run:${binding.runId}`
      ];
      if (
        (binding.provider === "claude" || binding.provider === "codex") &&
        binding.providerSessionId !== null
      ) {
        identities.push(`provider:${binding.provider}:${binding.providerSessionId}`);
      }
      return identities;
    }
  );
}

function unambiguousRuns(candidates: AgentRunRecord[]): AgentRunRecord[] {
  return retainUnambiguousRecords(
    candidates,
    runFingerprint,
    (run) => [`run:${run.runId}`]
  );
}

function retainUnambiguousRecords<T>(
  candidates: T[],
  fingerprintFor: (candidate: T) => string,
  identitiesFor: (candidate: T) => string[]
): T[] {
  const unique = new Map<string, T>();
  const claims = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const fingerprint = fingerprintFor(candidate);
    unique.set(fingerprint, candidate);
    for (const identity of identitiesFor(candidate)) {
      const fingerprints = claims.get(identity) ?? new Set<string>();
      fingerprints.add(fingerprint);
      claims.set(identity, fingerprints);
    }
  }
  return [...unique].flatMap(([fingerprint, candidate]) =>
    identitiesFor(candidate).every((identity) => claims.get(identity)?.size === 1)
      ? [candidate]
      : []
  );
}

function bindingFingerprint(binding: BindingRecord): string {
  return JSON.stringify([
    binding.bindingId,
    binding.runId,
    binding.taskId,
    binding.workspaceId,
    binding.paneId,
    binding.surfaceId,
    binding.provider,
    binding.providerSessionId,
    binding.attachedAt
  ]);
}

function runFingerprint(run: AgentRunRecord): string {
  return JSON.stringify([
    run.runId,
    run.taskId,
    run.provider,
    run.providerSessionId,
    run.relation,
    run.parentRunId,
    run.firstAttachedAt,
    run.lastAttachedAt
  ]);
}

function bindingMatchesRun(binding: BindingRecord, run: AgentRunRecord): boolean {
  return (
    binding.taskId === run.taskId &&
    binding.provider === run.provider &&
    binding.providerSessionId === run.providerSessionId
  );
}

function decodeProviderSessions(value: unknown): ProviderSessionMapping[] {
  if (!Array.isArray(value)) return [];
  const candidates: ProviderSessionMapping[] = [];
  for (const candidate of value.slice(0, MAX_PROVIDER_SESSIONS_PER_MACHINE)) {
    if (isProviderSessionMapping(candidate)) {
      candidates.push(normalizeProviderSessionMapping(candidate));
    }
    if (candidates.length >= MAX_PROVIDER_SESSIONS_PER_MACHINE) break;
  }
  const identitiesBySurface = new Map<string, Set<string>>();
  const surfacesByIdentity = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const identity = `${candidate.provider}:${candidate.providerSessionId}`;
    const surfaceIdentities = identitiesBySurface.get(candidate.surfaceId) ?? new Set<string>();
    surfaceIdentities.add(identity);
    identitiesBySurface.set(candidate.surfaceId, surfaceIdentities);
    const identitySurfaces = surfacesByIdentity.get(identity) ?? new Set<string>();
    identitySurfaces.add(candidate.surfaceId);
    surfacesByIdentity.set(identity, identitySurfaces);
  }

  const ambiguousSurfaces = new Set(
    [...identitiesBySurface].filter(([, identities]) => identities.size > 1).map(([surfaceId]) => surfaceId)
  );
  const ambiguousIdentities = new Set(
    [...surfacesByIdentity].filter(([, surfaces]) => surfaces.size > 1).map(([identity]) => identity)
  );
  const bySurface = new Map<string, ProviderSessionMapping>();
  for (const candidate of candidates) {
    const identity = `${candidate.provider}:${candidate.providerSessionId}`;
    if (
      ambiguousSurfaces.has(candidate.surfaceId) ||
      ambiguousIdentities.has(identity) ||
      bySurface.has(candidate.surfaceId)
    ) {
      continue;
    }
    bySurface.set(candidate.surfaceId, candidate);
  }
  return [...bySurface.values()];
}

export class BindingRepository {
  private readonly currentMachineId = machineId();
  private data: PersistedPluginData | null = null;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly plugin: Plugin,
    private readonly loadLegacyData: () => Promise<unknown> = () => loadLegacyPluginData(plugin)
  ) {}

  async load(): Promise<void> {
    let loaded: unknown = await this.plugin.loadData();
    let importedLegacyData = false;
    if (!hasPersistedPluginData(loaded)) {
      const legacyData = await this.loadLegacyData();
      if (hasPersistedPluginData(legacyData)) {
        loaded = legacyData;
        importedLegacyData = true;
      }
    }
    const raw = typeof loaded === "object" && loaded !== null ? (loaded as Record<string, unknown>) : {};
    const rawMachines =
      typeof raw.machines === "object" && raw.machines !== null
        ? (raw.machines as Record<string, unknown>)
        : {};
    const machines: Record<string, MachineBindings> = {};
    for (const [id, value] of Object.entries(rawMachines).slice(0, MAX_MACHINES)) {
      if (!MACHINE_ID_PATTERN.test(id)) continue;
      machines[id] = decodeMachine(value, id);
    }
    machines[this.currentMachineId] ??= { bindings: [], runs: [], providerSessions: [] };
    this.data = {
      schemaVersion: 3,
      settings: parseSettings(raw.settings),
      machines
    };
    if (importedLegacyData) await this.plugin.saveData(structuredClone(this.data));
  }

  getSettings(): AgentCockpitSettings {
    return { ...this.requireData().settings };
  }

  async updateSettings(settings: AgentCockpitSettings): Promise<void> {
    const parsed = parseSettings(settings);
    await this.commit((data) => {
      data.settings = parsed;
    });
  }

  list(): BindingRecord[] {
    return this.currentMachine().bindings.map((binding) => ({ ...binding }));
  }

  listRuns(taskId?: string): AgentRunRecord[] {
    const normalizedTaskId = taskId === undefined ? undefined : normalizeCanonicalUuid(taskId) ?? taskId;
    return this.currentMachine().runs
      .filter((run) => normalizedTaskId === undefined || run.taskId === normalizedTaskId)
      .map((run) => ({ ...run }))
      .sort((left, right) => right.lastAttachedAt.localeCompare(left.lastAttachedAt));
  }

  listProviderSessions(): ProviderSessionMapping[] {
    return this.currentMachine().providerSessions.map((mapping) => ({ ...mapping }));
  }

  async mapProviderSession(mapping: ProviderSessionMapping): Promise<void> {
    if (!isProviderSessionMapping(mapping)) {
      throw new Error("Provider session mapping contains an invalid canonical identity or value.");
    }
    const normalized = normalizeProviderSessionMapping(mapping);
    await this.commit((data) => {
      mapProviderSessionToMachine(this.machineFor(data), normalized);
    });
  }

  async mapProviderSessionIfUnchanged(
    mapping: ProviderSessionMapping,
    expected: ProviderSessionMapping | null
  ): Promise<boolean> {
    if (!isProviderSessionMapping(mapping)) {
      throw new Error("Provider session mapping contains an invalid canonical identity or value.");
    }
    if (expected !== null && !isProviderSessionMapping(expected)) {
      throw new Error("Expected provider session mapping contains an invalid canonical identity or value.");
    }
    const normalized = normalizeProviderSessionMapping(mapping);
    const normalizedExpected = expected === null ? null : normalizeProviderSessionMapping(expected);
    return this.commitConditional((data) => {
      const machine = this.machineFor(data);
      const current = machine.providerSessions.find(
        (candidate) => candidate.surfaceId === normalized.surfaceId
      ) ?? null;
      if (!sameProviderSessionMapping(current, normalizedExpected)) return false;
      mapProviderSessionToMachine(machine, normalized);
      return true;
    });
  }

  async forgetProviderSession(surfaceId: string): Promise<void> {
    const normalizedSurfaceId = normalizeCanonicalUuid(surfaceId);
    if (normalizedSurfaceId === null) throw new Error("Surface ID is not a canonical UUID.");
    await this.commit((data) => {
      const machine = this.machineFor(data);
      const removed = machine.providerSessions.find(
        (mapping) => mapping.surfaceId === normalizedSurfaceId
      );
      if (removed) forgetProviderSessionFromMachine(machine, removed);
    });
  }

  async forgetProviderSessionIfUnchanged(expected: ProviderSessionMapping): Promise<boolean> {
    if (!isProviderSessionMapping(expected)) {
      throw new Error("Expected provider session mapping contains an invalid canonical identity or value.");
    }
    const normalizedExpected = normalizeProviderSessionMapping(expected);
    return this.commitConditional((data) => {
      const machine = this.machineFor(data);
      const current = machine.providerSessions.find(
        (mapping) => mapping.surfaceId === normalizedExpected.surfaceId
      ) ?? null;
      if (!sameProviderSessionMapping(current, normalizedExpected)) return false;
      forgetProviderSessionFromMachine(machine, normalizedExpected);
      return true;
    });
  }

  findBySurface(surfaceId: string): BindingRecord | null {
    const normalizedSurfaceId = normalizeCanonicalUuid(surfaceId);
    if (normalizedSurfaceId === null) return null;
    const binding = this.currentMachine().bindings.find(
      (candidate) => candidate.surfaceId === normalizedSurfaceId
    );
    return binding ? { ...binding } : null;
  }

  async attach(input: NewBindingRecord): Promise<AttachBindingResult> {
    if (!isLegacyBinding(input)) throw new Error("Binding contains an invalid canonical identity or value.");
    const normalizedInput = normalizeNewBindingRecord(input);
    let result: AttachBindingResult | null = null;
    await this.commit((data) => {
      result = attachToMachine(this.machineFor(data), normalizedInput);
    });
    if (result === null) throw new Error(`${PRODUCT_NAME} could not persist the session attachment.`);
    return result;
  }

  async attachIfSurfaceUnchanged(
    input: NewBindingRecord,
    expected: BindingRecord | null
  ): Promise<AttachBindingResult | null> {
    if (!isLegacyBinding(input)) throw new Error("Binding contains an invalid canonical identity or value.");
    const normalizedInput = normalizeNewBindingRecord(input);
    if (expected !== null && !isBinding(expected)) {
      throw new Error("Expected binding contains an invalid canonical identity or value.");
    }
    const normalizedExpected = expected === null ? null : normalizeBindingRecord(expected);
    let result: AttachBindingResult | null = null;
    const committed = await this.commitConditional((data) => {
      const machine = this.machineFor(data);
      const current = machine.bindings.find(
        (candidate) => candidate.surfaceId === normalizedInput.surfaceId
      ) ?? null;
      if (!sameBinding(current, normalizedExpected)) {
        return false;
      }
      result = attachToMachine(machine, normalizedInput);
      return true;
    });
    if (!committed) return null;
    if (result === null) throw new Error(`${PRODUCT_NAME} could not persist the session attachment.`);
    return result;
  }

  async detach(surfaceId: string): Promise<void> {
    const normalizedSurfaceId = normalizeCanonicalUuid(surfaceId);
    if (normalizedSurfaceId === null) throw new Error("Surface ID is not a canonical UUID.");
    await this.commit((data) => {
      const machine = this.machineFor(data);
      machine.bindings = machine.bindings.filter(
        (binding) => binding.surfaceId !== normalizedSurfaceId
      );
    });
  }

  async detachIfUnchanged(expected: BindingRecord): Promise<boolean> {
    if (!isBinding(expected)) {
      throw new Error("Expected binding contains an invalid canonical identity or value.");
    }
    const normalizedExpected = normalizeBindingRecord(expected);
    return this.commitConditional((data) => {
      const machine = this.machineFor(data);
      const current = machine.bindings.find(
        (candidate) => candidate.surfaceId === normalizedExpected.surfaceId
      ) ?? null;
      if (!sameBinding(current, normalizedExpected)) return false;
      machine.bindings = machine.bindings.filter(
        (binding) => binding.surfaceId !== normalizedExpected.surfaceId
      );
      return true;
    });
  }

  async relocateProviderSession(input: RelocateBindingInput): Promise<BindingRecord> {
    if (!isRelocateBindingInput(input)) {
      throw new Error("Binding relocation contains an invalid canonical identity or value.");
    }
    const normalized = normalizeRelocateBindingInput(input);
    let relocated: BindingRecord | null = null;
    await this.commit((data) => {
      const machine = this.machineFor(data);
      const binding = machine.bindings.find(
        (candidate) => candidate.bindingId === normalized.bindingId
      );
      if (!binding || !bindingMatchesRelocationSource(binding, normalized)) {
        throw new Error("The provider-session binding changed before it could be relocated.");
      }
      const run = machine.runs.find((candidate) => candidate.runId === normalized.runId);
      if (
        !run ||
        run.taskId !== normalized.taskId ||
        run.provider !== normalized.provider ||
        run.providerSessionId !== normalized.providerSessionId
      ) {
        throw new Error("The provider-session run changed before its binding could be relocated.");
      }
      const conflictingBinding = machine.bindings.some(
        (candidate) =>
          candidate.bindingId !== binding.bindingId &&
          (candidate.surfaceId === normalized.toSurfaceId ||
            (candidate.provider === normalized.provider &&
              candidate.providerSessionId === normalized.providerSessionId))
      );
      if (conflictingBinding) {
        throw new Error("The relocation target is already claimed by another task binding.");
      }

      const identityMappings = machine.providerSessions.filter(
        (candidate) =>
          candidate.provider === normalized.provider &&
          candidate.providerSessionId === normalized.providerSessionId
      );
      const sourceSurfaceMapping = machine.providerSessions.find(
        (candidate) => candidate.surfaceId === normalized.fromSurfaceId
      );
      const targetSurfaceMapping = machine.providerSessions.find(
        (candidate) => candidate.surfaceId === normalized.toSurfaceId
      );
      const sourceMapping = identityMappings[0] ?? null;
      if (
        identityMappings.length > 1 ||
        (sourceSurfaceMapping !== undefined && sourceSurfaceMapping !== sourceMapping) ||
        (targetSurfaceMapping !== undefined && targetSurfaceMapping !== sourceMapping) ||
        (sourceMapping !== null && !providerMappingMatchesRelocationSource(sourceMapping, normalized))
      ) {
        throw new Error("The saved provider conversation changed before its binding could be relocated.");
      }

      binding.workspaceId = normalized.toWorkspaceId;
      binding.paneId = normalized.toPaneId;
      binding.surfaceId = normalized.toSurfaceId;
      binding.attachedAt = normalized.relocatedAt;
      run.lastAttachedAt = normalized.relocatedAt;
      if (sourceMapping !== null) {
        sourceMapping.workspaceId = normalized.toWorkspaceId;
        sourceMapping.paneId = normalized.toPaneId;
        sourceMapping.surfaceId = normalized.toSurfaceId;
        sourceMapping.matchedAt = normalized.relocatedAt;
      }
      relocated = { ...binding };
    });
    if (relocated === null) throw new Error(`${PRODUCT_NAME} could not relocate the session attachment.`);
    return relocated;
  }

  private currentMachine(): MachineBindings {
    return this.machineFor(this.requireData());
  }

  private machineFor(data: PersistedPluginData): MachineBindings {
    data.machines[this.currentMachineId] ??= { bindings: [], runs: [], providerSessions: [] };
    return data.machines[this.currentMachineId]!;
  }

  private requireData(): PersistedPluginData {
    if (this.data === null) throw new Error("BindingRepository must be loaded before use.");
    return this.data;
  }

  private commit(mutate: (draft: PersistedPluginData) => void): Promise<void> {
    const operation = this.saveChain.catch(() => undefined).then(async () => {
      const draft = structuredClone(this.requireData());
      mutate(draft);
      await this.persistDraft(draft);
    });
    this.saveChain = operation;
    return operation;
  }

  private commitConditional(mutate: (draft: PersistedPluginData) => boolean): Promise<boolean> {
    const operation = this.saveChain.catch(() => undefined).then(async () => {
      const draft = structuredClone(this.requireData());
      if (!mutate(draft)) return false;
      await this.persistDraft(draft);
      return true;
    });
    this.saveChain = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async persistDraft(draft: PersistedPluginData): Promise<void> {
    try {
      await this.plugin.saveData(draft);
    } catch (saveError) {
      try {
        const persisted = (await this.plugin.loadData()) as unknown;
        if (isDeepStrictEqual(persisted, draft)) {
          this.data = draft;
          return;
        }
      } catch {
        // Preserve the original write error when its postcondition cannot be proven.
      }
      throw saveError;
    }
    this.data = draft;
  }
}

function hasPersistedPluginData(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  return "schemaVersion" in value || "settings" in value || "machines" in value;
}

function inferRelation(latest: AgentRunRecord | null, input: NewBindingRecord): RunRelation {
  if (latest === null) return "initial";
  if (latest.provider !== input.provider) return "handoff";
  if (input.providerSessionId !== null && latest.providerSessionId === input.providerSessionId) return "resume";
  return "unknown";
}

function stableUuid(seed: string): string {
  const characters = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  characters[12] = "4";
  characters[16] = "89ab"[Number.parseInt(characters[16]!, 16) % 4]!;
  const hex = characters.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeProviderSessionId(value: string | null): string | null {
  return value === null ? null : normalizeCanonicalUuid(value) ?? value;
}

function isRelocateBindingInput(value: RelocateBindingInput): boolean {
  const ids = [
    value.bindingId,
    value.runId,
    value.taskId,
    value.providerSessionId,
    value.fromWorkspaceId,
    value.fromPaneId,
    value.fromSurfaceId,
    value.toWorkspaceId,
    value.toPaneId,
    value.toSurfaceId
  ];
  return (
    ids.every(isCanonicalUuid) &&
    (value.provider === "claude" || value.provider === "codex") &&
    validDate(value.relocatedAt) &&
    [value.fromWorkspaceId, value.fromPaneId, value.fromSurfaceId]
      .map((id) => normalizeCanonicalUuid(id))
      .join(":") !==
      [value.toWorkspaceId, value.toPaneId, value.toSurfaceId]
        .map((id) => normalizeCanonicalUuid(id))
        .join(":") &&
    new Set([
      normalizeCanonicalUuid(value.fromWorkspaceId),
      normalizeCanonicalUuid(value.fromPaneId),
      normalizeCanonicalUuid(value.fromSurfaceId)
    ]).size === 3 &&
    new Set([
      normalizeCanonicalUuid(value.toWorkspaceId),
      normalizeCanonicalUuid(value.toPaneId),
      normalizeCanonicalUuid(value.toSurfaceId)
    ]).size === 3
  );
}

function normalizeRelocateBindingInput(input: RelocateBindingInput): RelocateBindingInput {
  return {
    ...input,
    bindingId: normalizeCanonicalUuid(input.bindingId)!,
    runId: normalizeCanonicalUuid(input.runId)!,
    taskId: normalizeCanonicalUuid(input.taskId)!,
    providerSessionId: normalizeCanonicalUuid(input.providerSessionId)!,
    fromWorkspaceId: normalizeCanonicalUuid(input.fromWorkspaceId)!,
    fromPaneId: normalizeCanonicalUuid(input.fromPaneId)!,
    fromSurfaceId: normalizeCanonicalUuid(input.fromSurfaceId)!,
    toWorkspaceId: normalizeCanonicalUuid(input.toWorkspaceId)!,
    toPaneId: normalizeCanonicalUuid(input.toPaneId)!,
    toSurfaceId: normalizeCanonicalUuid(input.toSurfaceId)!
  };
}

function bindingMatchesRelocationSource(
  binding: BindingRecord,
  input: RelocateBindingInput
): boolean {
  return (
    binding.runId === input.runId &&
    binding.taskId === input.taskId &&
    binding.provider === input.provider &&
    binding.providerSessionId === input.providerSessionId &&
    binding.workspaceId === input.fromWorkspaceId &&
    binding.paneId === input.fromPaneId &&
    binding.surfaceId === input.fromSurfaceId
  );
}

function providerMappingMatchesRelocationSource(
  mapping: ProviderSessionMapping,
  input: RelocateBindingInput
): boolean {
  return (
    mapping.workspaceId === input.fromWorkspaceId &&
    mapping.paneId === input.fromPaneId &&
    mapping.surfaceId === input.fromSurfaceId
  );
}

function assertProviderSessionAvailable(
  machine: MachineBindings,
  input: NewBindingRecord
): void {
  if (
    (input.provider !== "claude" && input.provider !== "codex") ||
    input.providerSessionId === null ||
    !isCanonicalUuid(input.providerSessionId)
  ) {
    return;
  }

  const conflictingMapping = machine.providerSessions.find(
    (candidate) =>
      candidate.provider === input.provider &&
      candidate.providerSessionId === input.providerSessionId &&
      candidate.surfaceId !== input.surfaceId
  );
  const conflictingBinding = machine.bindings.find(
    (candidate) =>
      candidate.provider === input.provider &&
      candidate.providerSessionId === input.providerSessionId &&
      candidate.surfaceId !== input.surfaceId
  );
  const mappingForSurface = machine.providerSessions.find(
    (candidate) => candidate.surfaceId === input.surfaceId
  );
  const mappingChanged =
    mappingForSurface !== undefined &&
    (mappingForSurface.provider !== input.provider ||
      mappingForSurface.providerSessionId !== input.providerSessionId);

  if (conflictingMapping || conflictingBinding) {
    throw new Error("That provider conversation is already matched to another cmux surface.");
  }
  if (mappingChanged) {
    throw new Error("The saved provider conversation for this cmux surface changed before attachment.");
  }
}

function attachToMachine(
  machine: MachineBindings,
  input: NewBindingRecord
): AttachBindingResult {
  assertProviderSessionAvailable(machine, input);
  const existing = machine.bindings.find(
    (candidate) => candidate.surfaceId === input.surfaceId
  ) ?? null;
  const reusableRun = existing && existing.taskId === input.taskId
    ? machine.runs.find(
        (run) => run.runId === existing.runId && run.taskId === input.taskId
      ) ?? null
    : null;
  const isSameProviderSession =
    reusableRun !== null &&
    reusableRun.provider === input.provider &&
    (input.providerSessionId === null || reusableRun.providerSessionId === input.providerSessionId);
  const isNewRun = !isSameProviderSession;
  if (isNewRun && machine.runs.length >= MAX_RUNS_PER_MACHINE) {
    throw new Error(`This machine has reached the ${PRODUCT_NAME} run-history limit.`);
  }
  const latestTaskRun = machine.runs
    .filter((run) => run.taskId === input.taskId)
    .sort((left, right) => right.lastAttachedAt.localeCompare(left.lastAttachedAt))[0] ?? null;
  const run: AgentRunRecord = isSameProviderSession
    ? { ...reusableRun, lastAttachedAt: input.attachedAt }
    : {
        runId: randomUUID(),
        taskId: input.taskId,
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        relation: inferRelation(latestTaskRun, input),
        parentRunId: latestTaskRun?.runId ?? null,
        firstAttachedAt: input.attachedAt,
        lastAttachedAt: input.attachedAt
      };
  const binding: BindingRecord = {
    ...input,
    bindingId: existing?.bindingId ?? randomUUID(),
    runId: run.runId
  };
  const replacing = machine.bindings.some(
    (candidate) => candidate.surfaceId === binding.surfaceId
  );
  if (!replacing && machine.bindings.length >= MAX_BINDINGS_PER_MACHINE) {
    throw new Error(`This machine has reached the ${PRODUCT_NAME} binding limit.`);
  }
  machine.bindings = machine.bindings.filter(
    (candidate) => candidate.surfaceId !== binding.surfaceId
  );
  machine.bindings.push(binding);
  machine.runs = machine.runs.filter((candidate) => candidate.runId !== run.runId);
  machine.runs.push(run);
  return { binding: { ...binding }, run: { ...run }, isNewRun };
}

function sameBinding(left: BindingRecord | null, right: BindingRecord | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.bindingId === right.bindingId &&
    left.runId === right.runId &&
    left.taskId === right.taskId &&
    left.workspaceId === right.workspaceId &&
    left.paneId === right.paneId &&
    left.surfaceId === right.surfaceId &&
    left.provider === right.provider &&
    left.providerSessionId === right.providerSessionId &&
    left.attachedAt === right.attachedAt
  );
}

function sameProviderSessionMapping(
  left: ProviderSessionMapping | null,
  right: ProviderSessionMapping | null
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.workspaceId === right.workspaceId &&
    left.paneId === right.paneId &&
    left.surfaceId === right.surfaceId &&
    left.provider === right.provider &&
    left.providerSessionId === right.providerSessionId &&
    left.matchedAt === right.matchedAt
  );
}

function mapProviderSessionToMachine(
  machine: MachineBindings,
  normalized: ProviderSessionMapping
): void {
  const conflicting = machine.providerSessions.find(
    (candidate) =>
      candidate.provider === normalized.provider &&
      candidate.providerSessionId === normalized.providerSessionId &&
      candidate.surfaceId !== normalized.surfaceId
  );
  const conflictingBinding = machine.bindings.find(
    (candidate) =>
      candidate.provider === normalized.provider &&
      candidate.providerSessionId === normalized.providerSessionId &&
      candidate.surfaceId !== normalized.surfaceId
  );
  if (conflicting || conflictingBinding) {
    throw new Error("That provider conversation is already matched to another cmux surface.");
  }
  const binding = machine.bindings.find(
    (candidate) =>
      candidate.workspaceId === normalized.workspaceId &&
      candidate.paneId === normalized.paneId &&
      candidate.surfaceId === normalized.surfaceId
  );
  const run = binding === undefined
    ? undefined
    : machine.runs.find((candidate) => candidate.runId === binding.runId);
  if (binding !== undefined && (run === undefined || run.taskId !== binding.taskId)) {
    throw new Error("The linked run record does not match this task binding.");
  }
  const replacing = machine.providerSessions.some(
    (candidate) => candidate.surfaceId === normalized.surfaceId
  );
  if (!replacing && machine.providerSessions.length >= MAX_PROVIDER_SESSIONS_PER_MACHINE) {
    throw new Error(`${PRODUCT_NAME} has reached the provider-session mapping limit for this machine.`);
  }
  machine.providerSessions = machine.providerSessions.filter(
    (candidate) => candidate.surfaceId !== normalized.surfaceId
  );
  machine.providerSessions.push(normalized);

  if (binding !== undefined) {
    binding.provider = normalized.provider;
    binding.providerSessionId = normalized.providerSessionId;
    run!.provider = normalized.provider;
    run!.providerSessionId = normalized.providerSessionId;
  }
}

function forgetProviderSessionFromMachine(
  machine: MachineBindings,
  removed: ProviderSessionMapping
): void {
  machine.providerSessions = machine.providerSessions.filter(
    (mapping) => mapping.surfaceId !== removed.surfaceId
  );
  const binding = machine.bindings.find(
    (candidate) =>
      candidate.workspaceId === removed.workspaceId &&
      candidate.paneId === removed.paneId &&
      candidate.surfaceId === removed.surfaceId
  );
  if (
    binding?.provider === removed.provider &&
    binding.providerSessionId === removed.providerSessionId
  ) {
    binding.providerSessionId = null;
    const run = machine.runs.find((candidate) => candidate.runId === binding.runId);
    if (
      run?.taskId === binding.taskId &&
      run?.provider === removed.provider &&
      run.providerSessionId === removed.providerSessionId
    ) {
      run.providerSessionId = null;
    }
  }
}
