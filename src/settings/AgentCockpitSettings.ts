import { normalizePath } from "obsidian";
import {
  WORKFLOW_AUTOMATION_MODES,
  type WorkflowAutomationMode
} from "../workflow/WorkflowAutomationPolicy";

export interface AgentCockpitSettings {
  cmuxBinaryPath: string;
  taskFolder: string;
  autoTrackAgentRuns: boolean;
  workflowAutomation: WorkflowAutomationMode;
  previewLines: number;
  previewMaxBytes: number;
  staleAfterMs: number;
}

export const DEFAULT_SETTINGS: AgentCockpitSettings = {
  cmuxBinaryPath: "",
  taskFolder: "Agent Cockpit/Tasks",
  autoTrackAgentRuns: true,
  workflowAutomation: "suggest",
  previewLines: 60,
  previewMaxBytes: 16 * 1024,
  staleAfterMs: 30 * 60 * 1000
};

function finiteInRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? Math.round(value)
    : fallback;
}

export function normalizeTaskFolder(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_SETTINGS.taskFolder;
  const normalized = normalizePath(value.trim());
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.length > 512 ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return DEFAULT_SETTINGS.taskFolder;
  }
  return normalized;
}

export function parseSettings(value: unknown): AgentCockpitSettings {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    cmuxBinaryPath: typeof raw.cmuxBinaryPath === "string" ? raw.cmuxBinaryPath.trim() : "",
    taskFolder: normalizeTaskFolder(raw.taskFolder),
    autoTrackAgentRuns:
      typeof raw.autoTrackAgentRuns === "boolean"
        ? raw.autoTrackAgentRuns
        : DEFAULT_SETTINGS.autoTrackAgentRuns,
    workflowAutomation: WORKFLOW_AUTOMATION_MODES.includes(
      raw.workflowAutomation as WorkflowAutomationMode
    )
      ? (raw.workflowAutomation as WorkflowAutomationMode)
      : DEFAULT_SETTINGS.workflowAutomation,
    previewLines: finiteInRange(raw.previewLines, DEFAULT_SETTINGS.previewLines, 1, 80),
    previewMaxBytes: finiteInRange(raw.previewMaxBytes, DEFAULT_SETTINGS.previewMaxBytes, 4_096, 65_536),
    staleAfterMs: finiteInRange(raw.staleAfterMs, DEFAULT_SETTINGS.staleAfterMs, 5 * 60_000, 24 * 60 * 60_000)
  };
}
