import { Menu, setIcon } from "obsidian";
import type { SessionCardActions } from "../components/SessionCard";
import { providerLabel, repositoryLabel, sessionDisplayTitle } from "../components/SessionCard";
import { renderRuntimeBadge } from "../components/StatusBadge";
import type { CockpitState, LiveSession } from "../state/types";
import { DEFAULT_SESSION_INBOX_LIMIT, selectSessionInbox } from "./SessionInboxModel";

export interface SessionInboxActions
  extends Pick<
    SessionCardActions,
    "focus" | "attachTask" | "createTask" | "chooseConversation" | "forgetConversation"
  > {
  setShowAll(showAll: boolean): void;
}

export function renderSessionInbox(
  container: HTMLElement,
  state: Readonly<CockpitState>,
  showAll: boolean,
  actions: SessionInboxActions
): void {
  const selection = selectSessionInbox(state, showAll ? null : DEFAULT_SESSION_INBOX_LIMIT);
  const panel = container.createEl("section", {
    cls: "agent-cockpit-panel agent-cockpit-inbox-panel",
    attr: { "aria-labelledby": "agent-cockpit-inbox-heading" }
  });
  const heading = panel.createDiv({ cls: "agent-cockpit-panel-heading agent-cockpit-inbox-heading" });
  const title = heading.createDiv({ cls: "agent-cockpit-panel-title" });
  const titleLine = title.createDiv({ cls: "agent-cockpit-title-line" });
  titleLine.createEl("h2", { text: "Agent runs", attr: { id: "agent-cockpit-inbox-heading" } });
  titleLine.createSpan({
    cls: "agent-cockpit-count",
    text: String(selection.total),
    attr: { "aria-label": `${selection.total} untracked agent runs` }
  });
  title.createEl("p", {
    text: "Unlinked Claude and Codex runs stay here for manual review. Exact sessions are added to the work board automatically when enabled."
  });

  if (selection.total === 0) {
    const empty = panel.createDiv({ cls: "agent-cockpit-inline-empty" });
    const icon = empty.createSpan({ attr: { "aria-hidden": "true" } });
    setIcon(icon, "check-check");
    empty.createSpan({
      text: hasDetectedAgentRun(state.sessions)
        ? "Every confidently detected Claude or Codex run is represented on the work board."
        : "No unassigned Claude or Codex runs are confidently detected right now."
    });
    return;
  }

  const list = panel.createDiv({ cls: "agent-cockpit-inbox-list" });
  for (const session of selection.sessions) renderInboxRow(list, session, actions);

  if (selection.total > DEFAULT_SESSION_INBOX_LIMIT) {
    const footer = panel.createDiv({ cls: "agent-cockpit-inbox-footer" });
    footer.createSpan({
      text: showAll
        ? `${selection.total} untracked runs shown`
        : `${selection.total - selection.sessions.length} more runs hidden`
    });
    const show = footer.createEl("button", {
      text: showAll ? "Show fewer" : "Show all",
      attr: { type: "button", "data-focus-key": "inbox-show-all" }
    });
    show.addEventListener("click", () => actions.setShowAll(!showAll));
  }
}

function renderInboxRow(container: HTMLElement, session: LiveSession, actions: SessionInboxActions): void {
  const row = container.createDiv({ cls: "agent-cockpit-inbox-row" });
  const providerIcon = row.createSpan({ cls: "agent-cockpit-inbox-icon", attr: { "aria-hidden": "true" } });
  setIcon(providerIcon, session.provider.provider === "claude" ? "sparkles" : "square-terminal");

  const identity = row.createDiv({ cls: "agent-cockpit-inbox-identity" });
  identity.createDiv({
    cls: "agent-cockpit-session-title",
    text: sessionDisplayTitle(session)
  });
  identity.createDiv({
    cls: "agent-cockpit-session-meta",
    text: `${providerLabel(session.provider.provider)} · ${repositoryLabel(session.currentDirectory)} · ${session.workspaceTitle}${session.conversation ? "" : " · cmux title fallback"}`
  });

  const runtime = row.createDiv({ cls: "agent-cockpit-inbox-runtime" });
  renderRuntimeBadge(runtime, session.assessment);

  const rowActions = row.createDiv({ cls: "agent-cockpit-inbox-actions" });
  inboxButton(
    rowActions,
    "file-plus-2",
    "Track in board",
    "Create a durable Markdown task and attach this run",
    () => actions.createTask(session)
  );
  renderMoreButton(rowActions, session, actions);
}

function inboxButton(
  container: HTMLElement,
  iconName: string,
  label: string,
  title: string,
  onClick: () => void
): void {
  const button = container.createEl("button", {
    cls: "agent-cockpit-track-button",
    attr: { type: "button", title, "aria-label": title }
  });
  const icon = button.createSpan({ attr: { "aria-hidden": "true" } });
  setIcon(icon, iconName);
  button.createSpan({ text: label });
  button.addEventListener("click", onClick);
}

function renderMoreButton(container: HTMLElement, session: LiveSession, actions: SessionInboxActions): void {
  const button = container.createEl("button", {
    cls: "agent-cockpit-icon-button",
    attr: { type: "button", title: "More run actions", "aria-label": "More run actions" }
  });
  setIcon(button, "ellipsis");
  button.addEventListener("click", () => {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Focus in cmux")
        .setIcon("terminal")
        .onClick(() => actions.focus(session))
    );
    menu.addItem((item) =>
      item
        .setTitle("Attach to existing task")
        .setIcon("link")
        .onClick(() => actions.attachTask(session))
    );
    if (session.provider.provider === "claude" || session.provider.provider === "codex") {
      menu.addItem((item) =>
        item
          .setTitle(
            session.provider.source === "provider-session-mapping"
              ? "Change provider conversation"
              : "Choose provider conversation"
          )
          .setIcon("messages-square")
          .onClick(() => actions.chooseConversation(session))
      );
    }
    if (session.provider.source === "provider-session-mapping") {
      menu.addItem((item) =>
        item
          .setTitle("Forget conversation match")
          .setIcon("unlink")
          .onClick(() => actions.forgetConversation(session))
      );
    }
    const bounds = button.getBoundingClientRect();
    menu.showAtPosition({ x: bounds.right, y: bounds.bottom, left: true }, button.ownerDocument);
  });
}

function hasDetectedAgentRun(sessions: readonly LiveSession[]): boolean {
  return sessions.some(
    (session) => session.provider.provider === "claude" || session.provider.provider === "codex"
  );
}
