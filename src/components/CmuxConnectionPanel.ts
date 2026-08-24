import { setIcon } from "obsidian";
import {
  CMUX_PASSWORD_SETUP_STEPS,
  cmuxConnectionGuidance
} from "../cmux/accessSetup";
import type { ConnectionState } from "../state/types";

export interface CmuxConnectionPanelActions {
  retry: () => void;
  copySetupSteps: () => void;
}

export function renderCmuxConnectionPanel(
  container: HTMLElement,
  connection: ConnectionState,
  refreshing: boolean,
  actions: CmuxConnectionPanelActions
): void {
  const kind = cmuxConnectionGuidance(connection);
  if (kind === null) return;

  const panel = container.createEl("section", {
    cls: "agent-cockpit-connection-panel",
    attr: { "aria-labelledby": "agent-cockpit-connection-heading" }
  });
  panel.dataset.kind = kind;
  const icon = panel.createSpan({ cls: "agent-cockpit-connection-panel-icon", attr: { "aria-hidden": "true" } });
  setIcon(icon, kind === "setup" ? "shield-check" : "circle-alert");
  const body = panel.createDiv({ cls: "agent-cockpit-connection-panel-body" });

  if (kind === "setup") {
    renderSetup(body, connection, refreshing, actions);
  } else if (kind === "unsafe") {
    renderUnsafeMode(body, refreshing, actions);
  } else {
    renderUnavailable(body, connection, refreshing, actions);
  }
}

function renderSetup(
  body: HTMLElement,
  connection: ConnectionState,
  refreshing: boolean,
  actions: CmuxConnectionPanelActions
): void {
  body.createEl("h2", {
    text:
      connection.status === "connected"
        ? "Finish setup for normal Obsidian launches"
        : "Connect Agent Cockpit to cmux",
    attr: { id: "agent-cockpit-connection-heading" }
  });
  body.createEl("p", {
    text:
      connection.status === "connected"
        ? "This launch works through cmux process ancestry. Complete this once so Finder, Dock, and Spotlight launches work too."
        : "cmux is running, but its current socket policy rejects normally launched Obsidian processes."
  });

  const steps = body.createEl("ol", { cls: "agent-cockpit-setup-steps" });
  for (const step of CMUX_PASSWORD_SETUP_STEPS) steps.createEl("li", { text: step });
  body.createEl("p", {
    cls: "agent-cockpit-security-note",
    text: "The password remains in cmux's own Application Support storage. Agent Cockpit never reads, receives, logs, or stores it."
  });

  const alternative = body.createEl("details", { cls: "agent-cockpit-setup-alternative" });
  alternative.createEl("summary", { text: "Automation mode alternative" });
  alternative.createEl("p", {
    text: "Automation mode also supports normal launches, but it permits external clients running as your macOS user without a password. Never select Full open access."
  });
  alternative.createEl("p", {
    text: "If testing remains blocked after changing the mode, cmux may still be enforcing its previous listener policy. Restart cmux only when doing so will not disrupt active sessions."
  });
  renderActions(body, refreshing, actions, true);
}

function renderUnsafeMode(
  body: HTMLElement,
  refreshing: boolean,
  actions: CmuxConnectionPanelActions
): void {
  body.createEl("h2", {
    text: "cmux Full open access is enabled",
    attr: { id: "agent-cockpit-connection-heading" }
  });
  body.createEl("p", {
    text: "Agent Cockpit is connected, but this cmux mode permits unauthenticated local access. Switch cmux to Password mode, or Automation mode if that matches your threat model."
  });
  renderActions(body, refreshing, actions, true);
}

function renderUnavailable(
  body: HTMLElement,
  connection: ConnectionState,
  refreshing: boolean,
  actions: CmuxConnectionPanelActions
): void {
  body.createEl("h2", {
    text: connection.status === "connecting" ? "Connecting to cmux" : "cmux is unavailable",
    attr: { id: "agent-cockpit-connection-heading" }
  });
  body.createEl("p", { text: connection.message });
  renderActions(body, refreshing, actions, false);
}

function renderActions(
  body: HTMLElement,
  refreshing: boolean,
  actions: CmuxConnectionPanelActions,
  includeCopy: boolean
): void {
  const buttons = body.createDiv({ cls: "agent-cockpit-connection-panel-actions" });
  const retry = buttons.createEl("button", {
    cls: "mod-cta",
    text: refreshing ? "Testing…" : "Test connection",
    attr: { type: "button" }
  });
  retry.disabled = refreshing;
  retry.addEventListener("click", actions.retry);
  if (!includeCopy) return;
  const copy = buttons.createEl("button", { text: "Copy setup steps", attr: { type: "button" } });
  copy.addEventListener("click", actions.copySetupSteps);
}
