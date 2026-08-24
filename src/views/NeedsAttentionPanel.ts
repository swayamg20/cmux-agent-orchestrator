import { setIcon } from "obsidian";
import type { CockpitState } from "../state/types";
import type { SessionCardActions } from "../components/SessionCard";
import { renderSessionCard } from "../components/SessionCard";
import type { TaskRecord } from "../tasks/TaskSchema";

export interface AttentionPanelActions extends SessionCardActions {
  openTask(task: TaskRecord): void;
}

export function renderNeedsAttentionPanel(
  container: HTMLElement,
  state: Readonly<CockpitState>,
  expanded: Set<string>,
  actions: AttentionPanelActions
): void {
  const panel = container.createEl("section", {
    cls: `agent-cockpit-panel agent-cockpit-attention-panel${state.attention.length === 0 ? " is-clear" : ""}`,
    attr:
      state.attention.length === 0
        ? { "aria-label": "Attention status" }
        : { "aria-labelledby": "agent-cockpit-attention-heading" }
  });

  if (state.attention.length === 0) {
    const empty = panel.createDiv({ cls: "agent-cockpit-inline-empty" });
    const icon = empty.createSpan({ attr: { "aria-hidden": "true" } });
    setIcon(icon, "circle-check-big");
    empty.createSpan({ cls: "agent-cockpit-inline-empty-title", text: "Nothing needs attention" });
    empty.createSpan({
      text:
        state.connection.status === "connected"
          ? "No unread notifications or safely-derived runtime alerts."
          : "Live attention signals will return when cmux reconnects."
    });
    return;
  }

  const heading = panel.createDiv({ cls: "agent-cockpit-panel-heading" });
  const title = heading.createDiv({ cls: "agent-cockpit-panel-title" });
  const titleLine = title.createDiv({ cls: "agent-cockpit-title-line" });
  titleLine.createEl("h2", { text: "Attention", attr: { id: "agent-cockpit-attention-heading" } });
  titleLine.createSpan({
    cls: "agent-cockpit-count",
    text: `${state.attention.length}`,
    attr: { "aria-label": `${state.attention.length} attention items` }
  });
  title.createEl("p", { text: "Only signals that may need your judgment appear here." });

  const list = panel.createDiv({ cls: "agent-cockpit-attention-list" });
  for (const item of state.attention) {
    if (item.session) {
      renderSessionCard(list, {
        session: item.session,
        task: item.task,
        reasons: item.reasons,
        expanded: expanded.has(item.key),
        onExpandedChange: (isExpanded) => {
          if (isExpanded) expanded.add(item.key);
          else expanded.delete(item.key);
        },
        actions,
        variant: "attention"
      });
      continue;
    }
    const row = list.createDiv({ cls: "agent-cockpit-task-attention-row" });
    const identity = row.createDiv();
    identity.createDiv({ cls: "agent-cockpit-session-title", text: item.reasons[0]?.label ?? "Task needs attention" });
    identity.createDiv({ cls: "agent-cockpit-session-meta", text: item.task?.title ?? "Linked task unavailable" });
    if (item.reasons[0]?.detail) row.createDiv({ cls: "agent-cockpit-attention-detail", text: item.reasons[0].detail });
    if (item.task) {
      const button = row.createEl("button", { text: "Open task", attr: { type: "button" } });
      button.addEventListener("click", () => actions.openTask(item.task!));
    }
  }
}
