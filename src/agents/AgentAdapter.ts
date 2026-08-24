import type { CmuxSurface } from "../cmux/types";
import type { ProviderDetection } from "../state/types";

export interface AgentObservation {
  surface: CmuxSurface;
  preview: string | null;
}

export interface AgentAdapter {
  detect(observation: AgentObservation): ProviderDetection | null;
}

