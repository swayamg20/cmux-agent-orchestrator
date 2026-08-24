import type { AgentAdapter, AgentObservation } from "./AgentAdapter";
import type { ProviderDetection } from "../state/types";

const TITLE_PATTERN = /(?:^|[\s·|:—–])claude(?:\s+code)?(?=$|[\s·|:—–])/i;
const PREVIEW_HEADER_PATTERN = /(?:^|\n)\s*(?:Claude Code v\d|▐▛███▜▌)/m;
const PREVIEW_ACTIVITY_PATTERN = /(?:^|\n)\s*⏺\s+\S/m;

export class ClaudeAdapter implements AgentAdapter {
  detect({ surface, preview }: AgentObservation): ProviderDetection | null {
    if (TITLE_PATTERN.test(surface.title)) {
      return {
        provider: "claude",
        confidence: "high",
        source: "surface-title",
        explanation: "The terminal title explicitly identifies Claude.",
        sessionId: null
      };
    }
    if (preview !== null && PREVIEW_HEADER_PATTERN.test(preview)) {
      return {
        provider: "claude",
        confidence: "high",
        source: "screen-preview",
        explanation: "The bounded terminal preview contains a distinctive Claude Code header.",
        sessionId: null
      };
    }
    if (preview !== null && PREVIEW_ACTIVITY_PATTERN.test(preview)) {
      return {
        provider: "claude",
        confidence: "medium",
        source: "screen-preview",
        explanation: "The bounded terminal preview contains a distinctive Claude Code activity marker.",
        sessionId: null
      };
    }
    return null;
  }
}
