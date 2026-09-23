import { Modal, Setting, type App } from "obsidian";
import { FEEDBACK_LINKS, type FeedbackLinkKind } from "../support/FeedbackLinks";

interface FeedbackAction {
  kind: FeedbackLinkKind;
  label: string;
  description: string;
}

const FEEDBACK_ACTIONS: readonly FeedbackAction[] = [
  {
    kind: "bug",
    label: "Report a bug",
    description: "Something is broken or behaving differently than expected."
  },
  {
    kind: "compatibility",
    label: "Report a compatibility problem",
    description: "A cmux, Claude Code, Codex, or app version combination is not working."
  },
  {
    kind: "idea",
    label: "Suggest an idea",
    description: "Share an improvement or a new workflow in GitHub Discussions."
  },
  {
    kind: "question",
    label: "Ask a question",
    description: "Get usage help from the project community."
  },
  {
    kind: "security",
    label: "Report a security issue privately",
    description: "Open a private GitHub security advisory instead of a public issue."
  },
  {
    kind: "documentation",
    label: "Read support documentation",
    description: "See troubleshooting steps and which channel to use."
  }
];

export class HelpAndFeedbackModal extends Modal {
  private closed = false;

  constructor(
    app: App,
    private readonly diagnostics: string,
    private readonly copyDiagnostics: () => Promise<void>,
    private readonly onClosed: () => void = () => undefined
  ) {
    super(app);
  }

  override onOpen(): void {
    this.closed = false;
    this.titleEl.setText("Help and feedback");
    this.contentEl.empty();
    this.contentEl.addClass("agent-cockpit-support-modal");
    this.contentEl.createEl("p", {
      cls: "agent-cockpit-modal-intro",
      text: "Choose a destination below. Nothing is collected or sent automatically."
    });

    const actions = this.contentEl.createDiv({ cls: "agent-cockpit-support-actions" });
    for (const action of FEEDBACK_ACTIONS) this.renderLink(actions, action);

    const diagnosticsSection = this.contentEl.createEl("section", {
      cls: "agent-cockpit-support-diagnostics"
    });
    diagnosticsSection.createEl("h3", { text: "Diagnostics" });
    diagnosticsSection.createEl("p", {
      text: "Review this privacy-safe summary before copying or sharing it. It contains aggregate state only."
    });
    const preview = diagnosticsSection.createEl("textarea", {
      cls: "agent-cockpit-support-diagnostics-preview"
    });
    preview.value = this.diagnostics;
    preview.readOnly = true;
    preview.rows = 14;
    preview.setAttribute("aria-label", "Diagnostics preview");

    new Setting(diagnosticsSection).addButton((button) =>
      button
        .setCta()
        .setButtonText("Copy diagnostics")
        .onClick(() => {
          if (this.closed || button.buttonEl.disabled) return;
          button.setDisabled(true);
          void this.copyDiagnostics()
            .catch(() => undefined)
            .finally(() => {
              if (!this.closed) button.setDisabled(false);
            });
        })
    );
  }

  override onClose(): void {
    this.closed = true;
    this.contentEl.empty();
    this.onClosed();
  }

  private renderLink(container: HTMLElement, action: FeedbackAction): void {
    const link = container.createEl("a", {
      cls: "agent-cockpit-support-action",
      text: action.label
    });
    link.href = FEEDBACK_LINKS[action.kind];
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.createSpan({
      cls: "agent-cockpit-support-action-description",
      text: action.description
    });
  }
}
