import type { AgentAdapter, AgentObservation } from "./AgentAdapter";
import type { ProviderDetection } from "../state/types";

const TITLE_PATTERN = /(?:^|[\s·|:—–])codex(?=$|[\s·|:—–])/i;
const PREVIEW_HEADER_PATTERN = /(?:^|\n)\s*(?:>_\s*)?OpenAI Codex\s*\(v\d/m;
const PREVIEW_ACTIVITY_PATTERN =
  /(?:^|\n)\s*•\s+(?:Ran|Worked|Explored|Searched|Read|Edited|Added|Updated|Reviewed)\b/m;
const PREVIEW_PROMPT_PATTERN = /(?:^|\n)\s*›\s+\S/m;

export class CodexAdapter implements AgentAdapter {
  detect({ surface, preview }: AgentObservation): ProviderDetection | null {
    if (TITLE_PATTERN.test(surface.title)) {
      return {
        provider: "codex",
        confidence: "high",
        source: "surface-title",
        explanation: "The terminal title explicitly identifies Codex.",
        sessionId: null
      };
    }
    if (preview !== null && PREVIEW_HEADER_PATTERN.test(preview)) {
      return {
        provider: "codex",
        confidence: "high",
        source: "screen-preview",
        explanation: "The bounded terminal preview contains a distinctive OpenAI Codex header.",
        sessionId: null
      };
    }
    if (preview !== null && PREVIEW_ACTIVITY_PATTERN.test(preview)) {
      return {
        provider: "codex",
        confidence: "medium",
        source: "screen-preview",
        explanation: "The bounded terminal preview contains a distinctive Codex activity marker.",
        sessionId: null
      };
    }
    if (preview !== null && PREVIEW_PROMPT_PATTERN.test(preview)) {
      return {
        provider: "codex",
        confidence: "low",
        source: "screen-preview",
        explanation: "The bounded terminal preview resembles a Codex prompt, but the evidence is not conclusive.",
        sessionId: null
      };
    }
    return null;
  }
}
