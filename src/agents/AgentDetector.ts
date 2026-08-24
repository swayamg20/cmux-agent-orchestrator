import type { CmuxSurface } from "../cmux/types";
import type { ProviderDetection } from "../state/types";
import type { AgentAdapter } from "./AgentAdapter";
import { ClaudeAdapter } from "./ClaudeAdapter";
import { CodexAdapter } from "./CodexAdapter";
import { UnknownAdapter } from "./UnknownAdapter";

export class AgentDetector {
  private readonly adapters: AgentAdapter[];

  constructor(adapters: AgentAdapter[] = [new ClaudeAdapter(), new CodexAdapter(), new UnknownAdapter()]) {
    this.adapters = adapters;
  }

  detect(surface: CmuxSurface, preview: string | null = null): ProviderDetection {
    for (const adapter of this.adapters) {
      const result = adapter.detect({ surface, preview });
      if (result !== null) return result;
    }
    return new UnknownAdapter().detect({ surface, preview });
  }
}

