import { Modal, Setting, SuggestModal, type App } from "obsidian";
import type { LiveSession } from "../state/types";
import type { CreateTaskOptions } from "../tasks/TaskRepository";
import type { TaskPriority, TaskRecord } from "../tasks/TaskSchema";

export class TaskPickerModal extends SuggestModal<TaskRecord> {
  constructor(
    app: App,
    private readonly tasks: readonly TaskRecord[],
    private readonly choose: (task: TaskRecord) => void,
    private readonly closed: () => void = () => undefined
  ) {
    super(app);
    this.setPlaceholder("Attach to a task...");
    this.emptyStateText = "No tracked tasks found";
  }

  override getSuggestions(query: string): TaskRecord[] {
    const normalized = query.trim().toLowerCase();
    return this.tasks
      .filter(
        (task) =>
          !normalized ||
          task.title.toLowerCase().includes(normalized) ||
          task.repository?.toLowerCase().includes(normalized)
      )
      .slice(0, 50);
  }

  override renderSuggestion(task: TaskRecord, el: HTMLElement): void {
    el.createDiv({ cls: "suggestion-title", text: task.title });
    el.createDiv({
      cls: "suggestion-note",
      text: [task.workflowStatus, task.repository].filter(Boolean).join(" · ")
    });
  }

  override onChooseSuggestion(task: TaskRecord): void {
    this.choose(task);
  }

  override onClose(): void {
    super.onClose();
    this.closed();
  }
}

export class CreateTaskModal extends Modal {
  private title = "";
  private priority: TaskPriority = "normal";
  private repository: string | null;
  private readonly hasSession: boolean;

  constructor(
    app: App,
    session: LiveSession | null,
    private readonly create: (options: CreateTaskOptions) => Promise<void>,
    private readonly closed: () => void = () => undefined
  ) {
    super(app);
    this.hasSession = session !== null;
    this.title = session ? taskTitleFromSession(session) : "";
    this.repository = session?.currentDirectory ?? null;
  }

  override onOpen(): void {
    this.titleEl.setText(this.hasSession ? "Track run in work board" : "Create coding task");
    this.contentEl.empty();
    if (this.hasSession) {
      this.contentEl.createEl("p", {
        cls: "agent-cockpit-modal-intro",
        text: "This creates an active Markdown task and attaches the exact cmux surface. It does not pause, resume, or message the agent."
      });
    }
    new Setting(this.contentEl).setName("Task title").addText((text) => {
      text.setValue(this.title).setPlaceholder("Describe the work item").onChange((value) => {
        this.title = value;
      });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    new Setting(this.contentEl).setName("Repository").setDesc("Stored as task context only; never executed.").addText((text) =>
      text.setValue(this.repository ?? "").onChange((value) => {
        this.repository = value.trim() || null;
      })
    );
    new Setting(this.contentEl).setName("Priority").addDropdown((dropdown) =>
      dropdown
        .addOptions({ low: "Low", normal: "Normal", high: "High", urgent: "Urgent" })
        .setValue(this.priority)
        .onChange((value) => {
          if (value === "low" || value === "normal" || value === "high" || value === "urgent") {
            this.priority = value;
          }
        })
    );
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setCta()
          .setButtonText(this.hasSession ? "Add to board" : "Create task")
          .onClick(() => {
            if (!this.title.trim()) return;
            button.setDisabled(true);
            void this.create({
              title: this.title,
              priority: this.priority,
              workflowStatus: "active",
              repository: this.repository
            })
              .then(() => this.close())
              .catch(() => button.setDisabled(false));
          })
      );
  }

  override onClose(): void {
    this.contentEl.empty();
    this.closed();
  }
}

export function taskTitleFromSession(session: LiveSession): string {
  const repository = session.currentDirectory?.split("/").filter(Boolean).pop();
  return repository ? `${repository}: ${session.surfaceTitle}` : session.surfaceTitle;
}
