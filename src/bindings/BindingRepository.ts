import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";
import type { Plugin } from "obsidian";
import { isCanonicalUuid } from "../security/identifiers";
import { parseSettings, type AgentCockpitSettings } from "../settings/AgentCockpitSettings";
import type { BindingRecord, MachineBindings } from "./types";

const MAX_MACHINES = 100;
const MAX_BINDINGS_PER_MACHINE = 5_000;
const MACHINE_ID_PATTERN = /^[0-9a-f]{20}$/;

interface PersistedPluginData {
  schemaVersion: 1;
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

function isBinding(value: unknown): value is BindingRecord {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.taskId === "string" && isCanonicalUuid(raw.taskId) &&
    typeof raw.workspaceId === "string" && isCanonicalUuid(raw.workspaceId) &&
    typeof raw.paneId === "string" && isCanonicalUuid(raw.paneId) &&
    typeof raw.surfaceId === "string" && isCanonicalUuid(raw.surfaceId) &&
    (raw.provider === "claude" || raw.provider === "codex" || raw.provider === "shell" || raw.provider === "unknown") &&
    (raw.providerSessionId === null || (typeof raw.providerSessionId === "string" && raw.providerSessionId.length <= 256)) &&
    typeof raw.attachedAt === "string" &&
    raw.attachedAt.length <= 64 &&
    Number.isFinite(Date.parse(raw.attachedAt))
  );
}

function decodeBindings(value: unknown): BindingRecord[] {
  if (typeof value !== "object" || value === null) return [];
  const rawBindings = (value as Record<string, unknown>).bindings;
  if (!Array.isArray(rawBindings)) return [];
  const bySurface = new Map<string, BindingRecord>();
  for (const candidate of rawBindings) {
    if (isBinding(candidate)) bySurface.set(candidate.surfaceId, { ...candidate });
    if (bySurface.size >= MAX_BINDINGS_PER_MACHINE) break;
  }
  return [...bySurface.values()];
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
        ? (raw.machines as Record<string, { bindings?: unknown }>)
        : {};
    const machines: Record<string, MachineBindings> = {};
    for (const [id, value] of Object.entries(rawMachines).slice(0, MAX_MACHINES)) {
      if (!MACHINE_ID_PATTERN.test(id)) continue;
      machines[id] = { bindings: decodeBindings(value) };
    }
    machines[this.currentMachineId] ??= { bindings: [] };
    this.data = {
      schemaVersion: 1,
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

  findBySurface(surfaceId: string): BindingRecord | null {
    const binding = this.currentMachine().bindings.find((candidate) => candidate.surfaceId === surfaceId);
    return binding ? { ...binding } : null;
  }

  async attach(binding: BindingRecord): Promise<void> {
    if (!isBinding(binding)) throw new Error("Binding contains an invalid canonical identity or value.");
    await this.commit((data) => {
      const machine = this.machineFor(data);
      const replacing = machine.bindings.some((candidate) => candidate.surfaceId === binding.surfaceId);
      if (!replacing && machine.bindings.length >= MAX_BINDINGS_PER_MACHINE) {
        throw new Error("This machine has reached the Agent Cockpit binding limit.");
      }
      machine.bindings = machine.bindings.filter((candidate) => candidate.surfaceId !== binding.surfaceId);
      machine.bindings.push({ ...binding });
    });
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
    data.machines[this.currentMachineId] ??= { bindings: [] };
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
