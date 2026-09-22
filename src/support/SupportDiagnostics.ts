import { PRODUCT_NAME } from "../identity";
import type { AgentCockpitSettings } from "../settings/AgentCockpitSettings";
import type {
  CockpitState,
  ExecutionPhase,
  ProviderKind,
  SourceHealthStatus
} from "../state/types";
import { WORKFLOW_STATUSES, type WorkflowStatus } from "../tasks/TaskSchema";

const PROVIDERS: readonly ProviderKind[] = ["claude", "codex", "shell", "unknown"];
const EXECUTION_PHASES: readonly ExecutionPhase[] = [
  "unknown",
  "working",
  "waiting",
  "idle",
  "turn-finished",
  "failed"
];
const ACCESS_MODES = new Set(["cmuxOnly", "automation", "password", "allowAll"]);
const SAFE_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const CMUX_VERSION = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/;

export interface SupportDiagnostics {
  readonly product: string;
  readonly generatedAt: string;
  readonly versions: {
    readonly plugin: string;
    readonly obsidianApi: string;
    readonly cmux: string | null;
  };
  readonly connection: {
    readonly status: CockpitState["connection"]["status"];
    readonly accessMode: string | null;
    readonly customCmuxBinaryConfigured: boolean | null;
  };
  readonly sourceHealth: {
    readonly topology: SourceHealthStatus;
    readonly notifications: SourceHealthStatus;
    readonly lifecycle: SourceHealthStatus;
  };
  readonly inventory: {
    readonly sessions: number;
    readonly sessionsByProvider: Readonly<Record<ProviderKind, number>>;
    readonly sessionsByExecutionPhase: Readonly<Record<ExecutionPhase, number>>;
    readonly tasks: number;
    readonly tasksByWorkflow: Readonly<Record<WorkflowStatus, number>>;
    readonly bindings: number;
    readonly runs: number;
    readonly attentionItems: number;
  };
  readonly settings: {
    readonly loaded: boolean;
    readonly automaticTracking: boolean | null;
    readonly workflowAutomation: AgentCockpitSettings["workflowAutomation"] | null;
    readonly previewLines: number | null;
    readonly staleWorkingThresholdMs: number | null;
  };
}

export interface SupportDiagnosticsInput {
  readonly state: CockpitState;
  readonly settings: AgentCockpitSettings | null;
  readonly pluginVersion: string;
  readonly obsidianApiVersion: string;
  readonly generatedAt?: number;
}

export function buildSupportDiagnostics(input: SupportDiagnosticsInput): SupportDiagnostics {
  const { state, settings } = input;
  return {
    product: PRODUCT_NAME,
    generatedAt: new Date(input.generatedAt ?? Date.now()).toISOString(),
    versions: {
      plugin: sanitizedVersion(input.pluginVersion),
      obsidianApi: sanitizedVersion(input.obsidianApiVersion),
      cmux: cmuxVersion(state.connection.versionText)
    },
    connection: {
      status: state.connection.status,
      accessMode: sanitizedAccessMode(state.connection.accessMode),
      customCmuxBinaryConfigured: settings === null ? null : settings.cmuxBinaryPath.length > 0
    },
    sourceHealth: {
      topology: state.health.topology.status,
      notifications: state.health.notifications.status,
      lifecycle: state.health.lifecycle.status
    },
    inventory: {
      sessions: state.sessions.length,
      sessionsByProvider: countValues(PROVIDERS, state.sessions.map((session) => session.provider.provider)),
      sessionsByExecutionPhase: countValues(
        EXECUTION_PHASES,
        state.sessions.map((session) => session.assessment.executionPhase)
      ),
      tasks: state.tasks.length,
      tasksByWorkflow: countValues(
        WORKFLOW_STATUSES,
        state.tasks.map((task) => task.workflowStatus)
      ),
      bindings: state.bindings.length,
      runs: state.runs.length,
      attentionItems: state.attention.length
    },
    settings: {
      loaded: settings !== null,
      automaticTracking: settings?.autoTrackAgentRuns ?? null,
      workflowAutomation: settings?.workflowAutomation ?? null,
      previewLines: settings?.previewLines ?? null,
      staleWorkingThresholdMs: settings?.staleAfterMs ?? null
    }
  };
}

export function serializeSupportDiagnostics(diagnostics: SupportDiagnostics): string {
  return JSON.stringify(diagnostics, null, 2);
}

function countValues<T extends string>(values: readonly T[], observed: readonly T[]): Record<T, number> {
  const counts = Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
  for (const value of observed) counts[value] += 1;
  return counts;
}

function sanitizedVersion(value: string): string {
  const normalized = value.trim();
  return SAFE_VERSION.test(normalized) ? normalized : "unknown";
}

function cmuxVersion(value: string | null): string | null {
  return value?.match(CMUX_VERSION)?.[0] ?? null;
}

function sanitizedAccessMode(value: string | null): string | null {
  return value !== null && ACCESS_MODES.has(value) ? value : null;
}
