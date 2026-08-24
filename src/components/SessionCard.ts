import { setIcon } from "obsidian";
import type { AttentionReason, LiveSession } from "../state/types";
import type { TaskRecord } from "../tasks/TaskSchema";
import { renderConfidence, renderRuntimeBadge } from "./StatusBadge";

export interface SessionCardActions {
  loadPreview(session: LiveSession): void;
  focus(session: LiveSession): void;
  openTask(task: TaskRecord): void;
  attachTask(session: LiveSession): void;
  createTask(session: LiveSession): void;
  detachTask(session: LiveSession): void;
  copyMetadata(session: LiveSession): void;
}

export interface SessionCardOptions {
  session: LiveSession;
  task: TaskRecord | null;
  reasons?: readonly AttentionReason[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  actions: SessionCardActions;
  variant: "attention" | "session";
}

export function renderSessionCard(container: HTMLElement, options: SessionCardOptions): HTMLDetailsElement {
  const { session } = options;
  const details = container.createEl("details", {
    cls: `agent-cockpit-session-row agent-cockpit-session-row--${options.variant}`
  });
  details.open = options.expanded;
  const summary = details.createEl("summary", { cls: "agent-cockpit-session-summary" });
  const stateIcon = summary.createSpan({ cls: "agent-cockpit-session-icon", attr: { "aria-hidden": "true" } });
  setIcon(stateIcon, session.runtime.state === "error" ? "circle-alert" : session.runtime.state === "needs-input" ? "message-circle-question" : "terminal");

  const identity = summary.createDiv({ cls: "agent-cockpit-session-identity" });
  const title = identity.createDiv({ cls: "agent-cockpit-session-title" });
  if (options.reasons?.[0]) {
    title.createSpan({ text: options.reasons[0].label });
  } else {
    title.createSpan({ text: session.surfaceTitle || `Surface ${session.surfaceIndex + 1}` });
  }
  const metadata = identity.createDiv({ cls: "agent-cockpit-session-meta" });
  metadata.createSpan({ text: providerLabel(session.provider.provider) });
  metadata.createSpan({ text: " · " });
  metadata.createSpan({ text: repositoryLabel(session.currentDirectory) });
  metadata.createSpan({ text: " · " });
  metadata.createSpan({ text: session.workspaceTitle });
  if (options.task) {
    metadata.createSpan({ text: ` · ${options.task.title}` });
  }

  const trailing = summary.createDiv({ cls: "agent-cockpit-session-trailing" });
  renderRuntimeBadge(trailing, session.runtime);
  trailing.createSpan({
    cls: "agent-cockpit-observed-time",
    text:
      session.runtime.lastObservedChangeAt === null
        ? `seen ${formatRelativeTime(session.observedAt)}`
        : `changed ${formatRelativeTime(session.runtime.lastObservedChangeAt)}`
  });

  const body = details.createDiv({ cls: "agent-cockpit-session-body" });
  if (options.reasons?.length) renderReasons(body, options.reasons);
  renderSessionDetail(body, options);

  details.addEventListener("toggle", () => {
    options.onExpandedChange(details.open);
    if (details.open && session.preview === null) options.actions.loadPreview(session);
  });
  return details;
}

function renderReasons(container: HTMLElement, reasons: readonly AttentionReason[]): void {
  const list = container.createDiv({ cls: "agent-cockpit-reasons" });
  for (const reason of reasons) {
    const item = list.createDiv({ cls: "agent-cockpit-reason" });
    item.createSpan({ text: reason.detail });
    renderConfidence(item, reason.confidence);
  }
}

function renderSessionDetail(container: HTMLElement, options: SessionCardOptions): void {
  const { session, task, actions } = options;
  const grid = container.createDiv({ cls: "agent-cockpit-detail-grid" });
  const previewSection = grid.createDiv({ cls: "agent-cockpit-preview-section" });
  const previewHeading = previewSection.createDiv({ cls: "agent-cockpit-preview-heading" });
  previewHeading.createEl("h4", { text: "Terminal preview" });
  const refreshPreview = previewHeading.createEl("button", {
    text: session.preview === null ? "Load preview" : "Refresh preview",
    attr: { type: "button" }
  });
  refreshPreview.addEventListener("click", () => actions.loadPreview(session));
  previewSection.createDiv({ cls: "agent-cockpit-section-note", text: "Read-only · memory only · bounded" });
  if (session.preview === null) {
    previewSection.createDiv({
      cls: "agent-cockpit-preview-placeholder",
      text: "A bounded preview loads when this session is expanded or when requested above."
    });
  } else {
    const lastInput = findLastVisibleInput(session.preview.text);
    if (lastInput !== null) {
      const input = previewSection.createDiv({ cls: "agent-cockpit-last-input" });
      input.createSpan({ cls: "agent-cockpit-field-label", text: "Last visible input" });
      input.createSpan({ text: lastInput });
    }
    const preview = previewSection.createEl("pre", { cls: "agent-cockpit-terminal-preview" });
    preview.setText(session.preview.text || "The terminal screen is empty.");
    if (session.preview.truncated) previewSection.createDiv({ cls: "agent-cockpit-truncation", text: "Preview truncated" });
  }

  const evidence = grid.createDiv({ cls: "agent-cockpit-evidence-section" });
  evidence.createEl("h4", { text: "Runtime evidence" });
  const evidenceList = evidence.createEl("dl", { cls: "agent-cockpit-metadata-list" });
  addDefinition(evidenceList, "State", session.runtime.state);
  addDefinition(evidenceList, "Source", session.runtime.evidence.source);
  addDefinition(evidenceList, "Confidence", session.runtime.evidence.confidence);
  addDefinition(evidenceList, "Why", session.runtime.evidence.explanation);
  addDefinition(
    evidenceList,
    "Last observed change",
    session.runtime.lastObservedChangeAt === null
      ? "Not established in this plugin run"
      : new Date(session.runtime.lastObservedChangeAt).toLocaleString()
  );
  addDefinition(evidenceList, "Provider", `${providerLabel(session.provider.provider)} (${session.provider.confidence})`);
  addDefinition(evidenceList, "Repository / CWD", session.currentDirectory ?? "Unknown");
  addDefinition(evidenceList, "Workspace", `${session.workspaceTitle} · ${session.workspaceId}`);
  addDefinition(evidenceList, "Pane", session.paneId);
  addDefinition(evidenceList, "Surface", session.surfaceId);

  if (session.notifications.length > 0) {
    const notificationSection = container.createDiv({ cls: "agent-cockpit-notifications" });
    notificationSection.createEl("h4", { text: "cmux notifications" });
    for (const notification of session.notifications.slice(0, 3)) {
      const item = notificationSection.createDiv({ cls: "agent-cockpit-notification" });
      item.createSpan({ cls: "agent-cockpit-notification-state", text: notification.isRead ? "Read" : "Unread" });
      item.createSpan({ text: notification.title || notification.body || "Notification" });
    }
  }

  const actionsEl = container.createDiv({ cls: "agent-cockpit-row-actions" });
  actionButton(actionsEl, "terminal", "Focus in cmux", () => actions.focus(session), true);
  if (task) actionButton(actionsEl, "file-text", "Open task", () => actions.openTask(task));
  else actionButton(actionsEl, "link", "Attach task", () => actions.attachTask(session));
  actionButton(actionsEl, "file-plus-2", "Create task", () => actions.createTask(session));
  if (task) actionButton(actionsEl, "unlink", "Detach", () => actions.detachTask(session));
  actionButton(actionsEl, "copy", "Copy metadata", () => actions.copyMetadata(session));
}

function actionButton(
  container: HTMLElement,
  icon: string,
  label: string,
  callback: () => void,
  primary = false
): HTMLButtonElement {
  const button = container.createEl("button", {
    cls: primary ? "mod-cta agent-cockpit-action" : "agent-cockpit-action",
    attr: { type: "button" }
  });
  const iconEl = button.createSpan({ cls: "agent-cockpit-button-icon", attr: { "aria-hidden": "true" } });
  setIcon(iconEl, icon);
  button.createSpan({ text: label });
  button.addEventListener("click", callback);
  return button;
}

function addDefinition(list: HTMLDListElement, term: string, value: string): void {
  const row = list.createDiv({ cls: "agent-cockpit-definition" });
  row.createEl("dt", { text: term });
  row.createEl("dd", { text: value });
}

function findLastVisibleInput(text: string): string | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    const match = /^(?:you\s*:|[❯>])\s*(.+)$/i.exec(line);
    if (!match?.[1]) continue;
    const value = match[1].trim();
    return value.length > 240 ? `${value.slice(0, 237)}...` : value;
  }
  return null;
}

export function providerLabel(provider: LiveSession["provider"]["provider"]): string {
  const labels: Record<LiveSession["provider"]["provider"], string> = {
    claude: "Claude",
    codex: "Codex",
    shell: "Shell",
    unknown: "Unknown provider"
  };
  return labels[provider];
}

export function repositoryLabel(directory: string | null): string {
  if (!directory) return "Unknown repository";
  return directory.split("/").filter(Boolean).pop() ?? directory;
}

export function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
