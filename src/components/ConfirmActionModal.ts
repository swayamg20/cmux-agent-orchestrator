import { Modal, Setting, type App, type ButtonComponent } from "obsidian";

interface DestructiveButtonCompatibility {
  setDestructive?: () => unknown;
  setWarning: () => unknown;
}

function markDestructive(button: ButtonComponent): ButtonComponent {
  const compatible = button as unknown as DestructiveButtonCompatibility;
  if (compatible.setDestructive) compatible.setDestructive();
  else compatible.setWarning();
  return button;
}

export interface ConfirmActionDetails {
  title: string;
  explanation: string;
  targetLines: string[];
  confirmLabel: string;
}

export class ConfirmActionModal extends Modal {
  constructor(
    app: App,
    private readonly details: ConfirmActionDetails,
    private readonly onConfirm: () => void
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.details.title);
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: this.details.explanation });
    const targets = this.contentEl.createEl("dl", { cls: "agent-cockpit-confirm-targets" });
    for (const line of this.details.targetLines) targets.createEl("dd", { text: line });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        markDestructive(button)
          .setButtonText(this.details.confirmLabel)
          .onClick(() => {
            this.close();
            this.onConfirm();
          })
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
