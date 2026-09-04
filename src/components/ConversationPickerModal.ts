import { SuggestModal, type App } from "obsidian";
import type { ProviderSessionMetadata } from "../providers/types";

export class ConversationPickerModal extends SuggestModal<ProviderSessionMetadata> {
  constructor(
    app: App,
    private readonly sessions: readonly ProviderSessionMetadata[],
    private readonly choose: (session: ProviderSessionMetadata) => void,
    private readonly closed: () => void = () => undefined
  ) {
    super(app);
    const provider = sessions[0]?.provider === "claude" ? "Claude" : "Codex";
    this.setPlaceholder(`Choose the ${provider} conversation for this cmux surface...`);
    this.emptyStateText = "No matching conversations found for this repository";
  }

  override getSuggestions(query: string): ProviderSessionMetadata[] {
    const normalized = query.trim().toLowerCase();
    return this.sessions
      .filter(
        (session) =>
          !normalized ||
          session.title.toLowerCase().includes(normalized) ||
          session.sessionId.toLowerCase().includes(normalized)
      )
      .slice(0, 50);
  }

  override renderSuggestion(session: ProviderSessionMetadata, el: HTMLElement): void {
    el.createDiv({ cls: "suggestion-title", text: session.title });
    const details = [
      titleSourceLabel(session.titleSource),
      session.status,
      session.updatedAt === null ? null : formatProviderTime(session.updatedAt),
      session.sessionId.slice(0, 8)
    ].filter((value): value is string => Boolean(value));
    el.createDiv({
      cls: "suggestion-note",
      text: details.join(" · ")
    });
  }

  override onChooseSuggestion(session: ProviderSessionMetadata): void {
    this.choose(session);
  }

  override onClose(): void {
    super.onClose();
    this.closed();
  }
}

function titleSourceLabel(source: ProviderSessionMetadata["titleSource"]): string {
  const labels: Record<ProviderSessionMetadata["titleSource"], string> = {
    "explicit-name": "saved title",
    "ai-title": "generated title",
    "provider-preview": "preview fallback",
    "session-name": "session name",
    "session-id": "ID fallback"
  };
  return labels[source];
}

function formatProviderTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "updated just now";
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
}
