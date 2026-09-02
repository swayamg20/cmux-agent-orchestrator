import type { Confidence, ConnectionState, ExecutionPhase, SessionAssessment } from "../state/types";

export function renderConnectionBadge(container: HTMLElement, connection: ConnectionState): HTMLElement {
  const badge = container.createSpan({ cls: "agent-cockpit-connection" });
  badge.dataset.status = connection.status;
  badge.createSpan({ cls: "agent-cockpit-state-dot", attr: { "aria-hidden": "true" } });
  badge.createSpan({ text: connectionLabel(connection.status) });
  badge.setAttribute("aria-label", connection.message);
  badge.setAttribute("title", connection.message);
  return badge;
}

export function renderRuntimeBadge(container: HTMLElement, assessment: SessionAssessment): HTMLElement {
  const badge = container.createSpan({ cls: "agent-cockpit-runtime-badge" });
  badge.dataset.state = assessment.executionPhase;
  badge.createSpan({ cls: "agent-cockpit-state-dot", attr: { "aria-hidden": "true" } });
  badge.createSpan({ text: phaseLabel(assessment.executionPhase) });
  badge.setAttribute(
    "aria-label",
    `${phaseLabel(assessment.executionPhase)}, ${assessment.confidence} confidence, ${assessment.coverage} coverage. ${assessment.explanation}`
  );
  badge.setAttribute(
    "title",
    `${assessment.confidence} confidence · ${assessment.coverage} coverage · ${assessment.explanation}`
  );
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

export function phaseLabel(phase: ExecutionPhase): string {
  const labels: Record<ExecutionPhase, string> = {
    unknown: "State unknown",
    working: "Working",
    waiting: "Needs input",
    idle: "Idle",
    "turn-finished": "Review output",
    failed: "Error reported"
  };
  return labels[phase];
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
