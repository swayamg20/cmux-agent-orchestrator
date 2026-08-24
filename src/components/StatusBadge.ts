import type { Confidence, ConnectionState, RuntimeAssessment } from "../state/types";

export function renderConnectionBadge(container: HTMLElement, connection: ConnectionState): HTMLElement {
  const badge = container.createSpan({ cls: "agent-cockpit-connection" });
  badge.dataset.status = connection.status;
  badge.createSpan({ cls: "agent-cockpit-state-dot", attr: { "aria-hidden": "true" } });
  badge.createSpan({ text: connectionLabel(connection.status) });
  badge.setAttribute("aria-label", connection.message);
  badge.setAttribute("title", connection.message);
  return badge;
}

export function renderRuntimeBadge(container: HTMLElement, runtime: RuntimeAssessment): HTMLElement {
  const badge = container.createSpan({ cls: "agent-cockpit-runtime-badge" });
  badge.dataset.state = runtime.state;
  badge.createSpan({ cls: "agent-cockpit-state-dot", attr: { "aria-hidden": "true" } });
  badge.createSpan({ text: runtimeLabel(runtime.state) });
  badge.setAttribute(
    "aria-label",
    `${runtimeLabel(runtime.state)}, ${runtime.evidence.confidence} confidence. ${runtime.evidence.explanation}`
  );
  badge.setAttribute("title", `${runtime.evidence.confidence} confidence · ${runtime.evidence.explanation}`);
  return badge;
}

export function renderConfidence(container: HTMLElement, confidence: Confidence): HTMLElement {
  const element = container.createSpan({ cls: "agent-cockpit-confidence", text: `${capitalize(confidence)} confidence` });
  element.dataset.confidence = confidence;
  return element;
}

function connectionLabel(status: ConnectionState["status"]): string {
  const labels: Record<ConnectionState["status"], string> = {
    idle: "Not connected",
    connecting: "Connecting",
    connected: "cmux connected",
    "access-blocked": "Setup required",
    disconnected: "cmux disconnected",
    error: "Connection error"
  };
  return labels[status];
}

export function runtimeLabel(state: RuntimeAssessment["state"]): string {
  const labels: Record<RuntimeAssessment["state"], string> = {
    unknown: "Runtime: Unknown",
    running: "Runtime: Running",
    "needs-input": "Runtime: Needs input",
    idle: "Runtime: Idle",
    exited: "Runtime: Exited",
    error: "Runtime: Error"
  };
  return labels[state];
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
