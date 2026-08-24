import { createHash, randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import type { Plugin } from "obsidian";
import { isCanonicalUuid } from "../security/identifiers";
import { parseSettings, type AgentCockpitSettings } from "../settings/AgentCockpitSettings";
import type {
  AgentRunRecord,
  AttachBindingResult,
  BindingRecord,
  MachineBindings,
  NewBindingRecord,
  RunRelation
} from "./types";

const MAX_MACHINES = 100;
const MAX_BINDINGS_PER_MACHINE = 5_000;
const MAX_RUNS_PER_MACHINE = 20_000;
const MACHINE_ID_PATTERN = /^[0-9a-f]{20}$/;

interface PersistedPluginData {
  schemaVersion: 2;
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

function decodeMachine(value: unknown, id: string): MachineBindings {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const rawBindings = Array.isArray(raw.bindings) ? raw.bindings : [];
  const bindingsBySurface = new Map<string, BindingRecord>();
  const migratedRuns = new Map<string, AgentRunRecord>();
  for (const candidate of rawBindings) {
    let binding: BindingRecord | null = null;
    if (isBinding(candidate)) binding = { ...candidate };
    else if (isLegacyBinding(candidate)) {
      const runId = stableUuid(`run\0${id}\0${candidate.taskId}\0${candidate.surfaceId}\0${candidate.attachedAt}`);
      binding = {
        ...candidate,
        bindingId: stableUuid(`binding\0${id}\0${candidate.workspaceId}\0${candidate.surfaceId}\0${candidate.attachedAt}`),
        runId
      };
      migratedRuns.set(runId, {
        runId,
        taskId: candidate.taskId,
        provider: candidate.provider,
        providerSessionId: candidate.providerSessionId,
        relation: "unknown",
        parentRunId: null,
        firstAttachedAt: candidate.attachedAt,
        lastAttachedAt: candidate.attachedAt
      });
    }
    if (binding) bindingsBySurface.set(binding.surfaceId, binding);
    if (bindingsBySurface.size >= MAX_BINDINGS_PER_MACHINE) break;
  }

  const runsById = new Map<string, AgentRunRecord>();
  if (Array.isArray(raw.runs)) {
    for (const candidate of raw.runs) {
      if (isRun(candidate)) runsById.set(candidate.runId, { ...candidate });
      if (runsById.size >= MAX_RUNS_PER_MACHINE) break;
    }
  }
  for (const [runId, run] of migratedRuns) {
    if (!runsById.has(runId)) runsById.set(runId, run);
  }
  return { bindings: [...bindingsBySurface.values()], runs: [...runsById.values()] };
}

export class BindingRepository {
  private readonly currentMachineId = machineId();
  private data: PersistedPluginData | null = null;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(private readonly plugin: Plugin) {}

  async load(): Promise<void> {
    const loaded: unknown = await this.plugin.loadData();
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
    machines[this.currentMachineId] ??= { bindings: [], runs: [] };
    this.data = {
      schemaVersion: 2,
      settings: parseSettings(raw.settings),
      machines
    };
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
    return this.currentMachine().runs
      .filter((run) => taskId === undefined || run.taskId === taskId)
      .map((run) => ({ ...run }))
      .sort((left, right) => right.lastAttachedAt.localeCompare(left.lastAttachedAt));
  }

  findBySurface(surfaceId: string): BindingRecord | null {
    const binding = this.currentMachine().bindings.find((candidate) => candidate.surfaceId === surfaceId);
    return binding ? { ...binding } : null;
  }

  async attach(input: NewBindingRecord): Promise<AttachBindingResult> {
    if (!isLegacyBinding(input)) throw new Error("Binding contains an invalid canonical identity or value.");
    let result: AttachBindingResult | null = null;
    await this.commit((data) => {
      const machine = this.machineFor(data);
      const existing = machine.bindings.find((candidate) => candidate.surfaceId === input.surfaceId) ?? null;
      const reusableRun = existing && existing.taskId === input.taskId
        ? machine.runs.find((run) => run.runId === existing.runId) ?? null
        : null;
      const isSameProviderSession =
        reusableRun !== null &&
        reusableRun.provider === input.provider &&
        (input.providerSessionId === null || reusableRun.providerSessionId === input.providerSessionId);
      const isNewRun = !isSameProviderSession;
      if (isNewRun && machine.runs.length >= MAX_RUNS_PER_MACHINE) {
        throw new Error("This machine has reached the Agent Cockpit run-history limit.");
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
      const replacing = machine.bindings.some((candidate) => candidate.surfaceId === binding.surfaceId);
      if (!replacing && machine.bindings.length >= MAX_BINDINGS_PER_MACHINE) {
        throw new Error("This machine has reached the Agent Cockpit binding limit.");
      }
      machine.bindings = machine.bindings.filter((candidate) => candidate.surfaceId !== binding.surfaceId);
      machine.bindings.push(binding);
      machine.runs = machine.runs.filter((candidate) => candidate.runId !== run.runId);
      machine.runs.push(run);
      result = { binding: { ...binding }, run: { ...run }, isNewRun };
    });
    if (result === null) throw new Error("Agent Cockpit could not persist the session attachment.");
    return result;
  }

  async detach(surfaceId: string): Promise<void> {
    if (!isCanonicalUuid(surfaceId)) throw new Error("Surface ID is not a canonical UUID.");
    await this.commit((data) => {
      const machine = this.machineFor(data);
      machine.bindings = machine.bindings.filter((binding) => binding.surfaceId !== surfaceId);
    });
  }

  private currentMachine(): MachineBindings {
    return this.machineFor(this.requireData());
  }

  private machineFor(data: PersistedPluginData): MachineBindings {
    data.machines[this.currentMachineId] ??= { bindings: [], runs: [] };
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
      await this.plugin.saveData(draft);
      this.data = draft;
    });
    this.saveChain = operation;
    return operation;
  }
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
