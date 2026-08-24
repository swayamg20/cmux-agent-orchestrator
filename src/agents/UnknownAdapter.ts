import type { AgentAdapter, AgentObservation } from "./AgentAdapter";
import type { ProviderDetection } from "../state/types";

const SHELL_PATTERN = /^(?:zsh|bash|fish|sh|login|terminal)(?:\s|$)/i;

export class UnknownAdapter implements AgentAdapter {
  detect({ surface }: AgentObservation): ProviderDetection {
    if (SHELL_PATTERN.test(surface.title)) {
      return {
        provider: "shell",
        confidence: "medium",
        source: "surface-title",
        explanation: "The terminal title identifies a shell and no agent marker is present.",
        sessionId: null
      };
    }
    return {
      provider: "unknown",
      confidence: "low",
      source: surface.type ? "surface-type" : "none",
      explanation: "No reliable Claude or Codex marker is available.",
      sessionId: null
    };
  }
}

