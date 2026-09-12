import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type { AgentCockpitController, BulkParkResult } from "../app/AgentCockpitController";
import { runUiAction } from "../app/runUiAction";
import { renderConnectionBadge } from "../components/StatusBadge";
import { PRODUCT_NAME } from "../identity";
import type { CockpitState } from "../state/types";
import type { TaskRecord } from "../tasks/TaskSchema";
import { renderKanbanBoard } from "./KanbanPanel";
import {
  canTriageNoLiveTasks,
  selectParkableNoLiveTasks,
  selectWorkBoardTasks,
  type WorkBoardRunFilter
} from "./WorkBoardModel";

export const WORK_BOARD_VIEW_TYPE = "cmux-agent-orchestrator-work-board";

export class WorkBoardView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private query = "";
  private runFilter: WorkBoardRunFilter = "all";
  private triageMode = false;
  private selectedTaskIds = new Set<string>();
  private busy = false;
  private statusMessage = "";
  private queuedState: Readonly<CockpitState> | null = null;
  private animationFrame: number | null = null;
  private opened = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly controller: AgentCockpitController,
    private readonly openOrchestrator: () => Promise<void>
  ) {
    super(leaf);
    this.navigation = false;
  }

  getViewType(): string {
    return WORK_BOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Work board";
  }

  override getIcon(): string {
    return "columns-3";
  }

  protected override async onOpen(): Promise<void> {
    this.opened = true;
    this.contentEl.addClass("agent-cockpit-board-view-content");
    this.unsubscribe = this.controller.store.subscribe((state) => this.scheduleRender(state));
  }

  protected override async onClose(): Promise<void> {
    this.opened = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.animationFrame !== null) {
      this.contentEl.ownerDocument.defaultView?.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.queuedState = null;
    this.contentEl.empty();
  }

  private scheduleRender(state: Readonly<CockpitState>): void {
    if (!this.opened) return;
    this.queuedState = state;
    if (this.animationFrame !== null) return;
    const view = this.contentEl.ownerDocument.defaultView;
    if (!view) {
      queueMicrotask(() => this.flushRender());
      return;
    }
    this.animationFrame = view.requestAnimationFrame(() => {
      this.animationFrame = null;
      this.flushRender();
    });
  }

  private flushRender(): void {
    const pending = this.queuedState;
    this.queuedState = null;
    if (pending) this.render(pending);
  }

  private render(state: Readonly<CockpitState>): void {
    const active = this.contentEl.ownerDocument.activeElement as HTMLInputElement | HTMLElement | null;
    const focusKey = active?.dataset.focusKey ?? null;
    const selection = active instanceof HTMLInputElement
      ? { start: active.selectionStart, end: active.selectionEnd }
      : null;
    const scrollState = captureBoardScroll(this.contentEl);
    const parkableTasks = selectParkableNoLiveTasks(state);
    const parkableIds = new Set(parkableTasks.map((task) => task.taskId));
    this.selectedTaskIds = new Set(
      [...this.selectedTaskIds].filter((taskId) => parkableIds.has(taskId))
    );

    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "agent-cockpit agent-cockpit-board-view" });
    this.renderHeader(root, state);
    const visible = selectWorkBoardTasks(
      state,
      this.query,
      this.runFilter,
      this.triageMode
    );
    this.renderToolbar(root, state, parkableTasks, visible.tasks);
    if (this.triageMode) this.renderTriageBar(root, state, visible.tasks);

    const boardHost = root.createEl("main", {
      cls: "agent-cockpit-board-host",
      attr: { "aria-label": "Work board" }
    });
    const resultLine = boardHost.createDiv({ cls: "agent-cockpit-board-result-line" });
    resultLine.createSpan({
      text: `${visible.tasks.length} of ${state.tasks.length} ${state.tasks.length === 1 ? "task" : "tasks"}`
    });
    if (this.query.trim()) resultLine.createSpan({ text: `matching “${this.query.trim()}”` });
    renderKanbanBoard(boardHost, state, {
      openTask: (task) => void this.controller.openTask(task),
      moveTask: (task, status) => this.controller.updateWorkflow(task, status),
      apply: (proposal) => this.controller.applyWorkflowProposal(proposal),
      reviewInCmux: (proposal) => this.controller.reviewWorkflowProposalInCmux(proposal),
      dismiss: (proposal) => this.controller.dismissWorkflowProposal(proposal)
    }, {
      tasks: visible.tasks,
      ...(this.triageMode
        ? {
            selection: {
              selectedTaskIds: this.selectedTaskIds,
              toggleTask: (task: TaskRecord, selected: boolean) => {
                if (!parkableIds.has(task.taskId) || this.busy) return;
                const next = new Set(this.selectedTaskIds);
                if (selected) next.add(task.taskId);
                else next.delete(task.taskId);
                this.selectedTaskIds = next;
                this.scheduleRender(this.controller.store.getState());
              }
            }
          }
        : {})
    });
    root.createDiv({
      cls: "agent-cockpit-visually-hidden",
      text: this.statusMessage,
      attr: { role: "status", "aria-live": "polite" }
    });

    restoreBoardScroll(this.contentEl, scrollState);
    if (focusKey) {
      const next = this.contentEl.querySelector<HTMLElement>(
        `[data-focus-key="${CSS.escape(focusKey)}"]`
      );
      next?.focus({ preventScroll: true });
      if (selection !== null && next instanceof HTMLInputElement) {
        next.setSelectionRange(selection.start, selection.end);
      }
    }
  }

  private renderHeader(container: HTMLElement, state: Readonly<CockpitState>): void {
    const header = container.createEl("header", { cls: "agent-cockpit-header agent-cockpit-board-header" });
    const identity = header.createDiv({ cls: "agent-cockpit-heading-group" });
    const titleLine = identity.createDiv({ cls: "agent-cockpit-heading-line" });
    titleLine.createEl("h1", { text: "Work board" });
    renderConnectionBadge(titleLine, state.connection);
    identity.createDiv({ cls: "agent-cockpit-board-product", text: PRODUCT_NAME });

    const actions = header.createDiv({ cls: "agent-cockpit-header-actions" });
    const orchestrator = actions.createEl("button", {
      attr: { type: "button", "aria-label": `Open ${PRODUCT_NAME}` }
    });
    setIcon(orchestrator, "layout-dashboard");
    orchestrator.createSpan({ text: "Orchestrator" });
    orchestrator.addEventListener("click", () => void runUiAction(
      () => this.openOrchestrator(),
      `Could not open ${PRODUCT_NAME}.`,
      () => this.opened
    ));
    const create = actions.createEl("button", {
      attr: { type: "button", "aria-label": "Create task" }
    });
    setIcon(create, "file-plus-2");
    create.createSpan({ text: "New task" });
    create.addEventListener("click", () => this.controller.showCreateTask(null));
    const refresh = actions.createEl("button", {
      attr: {
        type: "button",
        "aria-label": state.refreshing ? "Refreshing work board" : "Refresh work board"
      }
    });
    setIcon(refresh, "refresh-cw");
    refresh.createSpan({ text: state.refreshing ? "Refreshing" : "Refresh" });
    refresh.disabled = state.refreshing;
    refresh.addEventListener("click", () => void this.controller.refreshNow());
  }

  private renderToolbar(
    container: HTMLElement,
    state: Readonly<CockpitState>,
    parkableTasks: readonly TaskRecord[],
    visibleTasks: readonly TaskRecord[]
  ): void {
    const toolbar = container.createDiv({
      cls: "agent-cockpit-board-toolbar",
      attr: { role: "search", "aria-label": "Filter work board" }
    });
    const search = toolbar.createEl("label", { cls: "agent-cockpit-board-search" });
    search.createSpan({ cls: "agent-cockpit-filter-label", text: "Search" });
    const input = search.createEl("input", {
      attr: {
        type: "search",
        placeholder: "Title, repository, branch, or worktree",
        "aria-label": "Search work board",
        "data-focus-key": "board-search"
      }
    });
    input.value = this.query;
    input.addEventListener("input", () => {
      this.query = input.value.slice(0, 512);
      this.scheduleRender(this.controller.store.getState());
    });

    const runFilter = toolbar.createEl("label", { cls: "agent-cockpit-board-filter" });
    runFilter.createSpan({ cls: "agent-cockpit-filter-label", text: "Run" });
    const select = runFilter.createEl("select", {
      attr: { "aria-label": "Filter tasks by live run", "data-focus-key": "board-run-filter" }
    });
    for (const [value, label] of [
      ["all", "All tasks"],
      ["live", "Has live run"],
      ["no-live", "No live run"]
    ] as const) {
      const option = select.createEl("option", { value, text: label });
      option.selected = this.runFilter === value;
    }
    select.disabled = this.triageMode || this.busy;
    select.addEventListener("change", () => {
      this.runFilter = select.value as WorkBoardRunFilter;
      this.scheduleRender(this.controller.store.getState());
    });

    const triage = toolbar.createEl("button", {
      cls: "agent-cockpit-board-triage-button",
      attr: {
        type: "button",
        "data-focus-key": "board-triage",
        title: triageButtonTitle(state, parkableTasks.length)
      }
    });
    setIcon(triage, "list-checks");
    triage.createSpan({ text: `Review no-live (${parkableTasks.length})` });
    triage.disabled = this.triageMode || this.busy || parkableTasks.length === 0;
    triage.addEventListener("click", () => {
      this.triageMode = true;
      this.runFilter = "no-live";
      this.selectedTaskIds.clear();
      this.statusMessage = `${parkableTasks.length} active tasks are ready for review.`;
      this.scheduleRender(this.controller.store.getState());
    });

    toolbar.createDiv({
      cls: "agent-cockpit-board-toolbar-summary",
      text: `${visibleTasks.length} shown`
    });
  }

  private renderTriageBar(
    container: HTMLElement,
    state: Readonly<CockpitState>,
    visibleTasks: readonly TaskRecord[]
  ): void {
    const authorityAvailable = canTriageNoLiveTasks(state);
    const bar = container.createDiv({
      cls: "agent-cockpit-board-triage",
      attr: { "aria-label": "Review tasks without a live run" }
    });
    const copy = bar.createDiv({ cls: "agent-cockpit-board-triage-copy" });
    copy.createDiv({ cls: "agent-cockpit-board-triage-title", text: "Review tasks without a live run" });
    copy.createDiv({
      cls: "agent-cockpit-board-triage-detail",
      text: authorityAvailable
        ? "Select active tasks to park. This changes task workflow only and never controls an agent."
        : "Reconnect and refresh cmux before parking; the plugin will not act on stale topology."
    });
    const actions = bar.createDiv({ cls: "agent-cockpit-board-triage-actions" });
    const selectAll = actions.createEl("button", {
      text: "Select all shown",
      attr: { type: "button", "data-focus-key": "board-select-all" }
    });
    selectAll.disabled = this.busy || !authorityAvailable || visibleTasks.length === 0;
    selectAll.addEventListener("click", () => {
      this.selectedTaskIds = new Set(visibleTasks.map((task) => task.taskId));
      this.scheduleRender(this.controller.store.getState());
    });
    const clear = actions.createEl("button", {
      text: "Clear",
      attr: { type: "button", "data-focus-key": "board-clear-selection" }
    });
    clear.disabled = this.busy || this.selectedTaskIds.size === 0;
    clear.addEventListener("click", () => {
      this.selectedTaskIds.clear();
      this.scheduleRender(this.controller.store.getState());
    });
    const park = actions.createEl("button", {
      cls: "mod-warning",
      text: this.busy ? "Parking…" : `Park selected (${this.selectedTaskIds.size})`,
      attr: { type: "button", "data-focus-key": "board-park-selected" }
    });
    park.disabled = this.busy || !authorityAvailable || this.selectedTaskIds.size === 0;
    park.addEventListener("click", () => void this.parkSelected());
    const cancel = actions.createEl("button", {
      text: "Cancel",
      attr: { type: "button", "data-focus-key": "board-cancel-triage" }
    });
    cancel.disabled = this.busy;
    cancel.addEventListener("click", () => {
      this.triageMode = false;
      this.runFilter = "all";
      this.selectedTaskIds.clear();
      this.statusMessage = "Task review cancelled.";
      this.scheduleRender(this.controller.store.getState());
    });
  }

  private async parkSelected(): Promise<void> {
    if (this.busy || this.selectedTaskIds.size === 0) return;
    this.busy = true;
    this.scheduleRender(this.controller.store.getState());
    let result: BulkParkResult | null = null;
    try {
      result = await this.controller.parkTasksWithoutLiveSessions([...this.selectedTaskIds]);
    } catch (error) {
      if (this.opened) {
        new Notice(error instanceof Error && error.message.trim()
          ? error.message
          : "Could not park the selected tasks.");
      }
    }
    this.busy = false;
    if (!this.opened || result === null) return;
    this.triageMode = false;
    this.runFilter = "all";
    this.selectedTaskIds.clear();
    this.statusMessage = `${result.parked} ${result.parked === 1 ? "task" : "tasks"} parked${result.skipped > 0 ? `; ${result.skipped} skipped` : ""}.`;
    this.scheduleRender(this.controller.store.getState());
  }
}

interface BoardScrollState {
  boardLeft: number;
  columns: Map<string, number>;
}

function captureBoardScroll(container: HTMLElement): BoardScrollState {
  const board = container.querySelector<HTMLElement>(".agent-cockpit-kanban-board");
  const columns = new Map<string, number>();
  for (const list of container.querySelectorAll<HTMLElement>(".agent-cockpit-kanban-task-list")) {
    const status = list.closest<HTMLElement>(".agent-cockpit-kanban-column")?.dataset.status;
    if (status) columns.set(status, list.scrollTop);
  }
  return { boardLeft: board?.scrollLeft ?? 0, columns };
}

function restoreBoardScroll(container: HTMLElement, state: BoardScrollState): void {
  const board = container.querySelector<HTMLElement>(".agent-cockpit-kanban-board");
  if (board) board.scrollLeft = state.boardLeft;
  for (const list of container.querySelectorAll<HTMLElement>(".agent-cockpit-kanban-task-list")) {
    const status = list.closest<HTMLElement>(".agent-cockpit-kanban-column")?.dataset.status;
    if (status) list.scrollTop = state.columns.get(status) ?? 0;
  }
}

function triageButtonTitle(state: Readonly<CockpitState>, parkableCount: number): string {
  if (state.connection.status !== "connected") {
    return "Reconnect to cmux before reviewing tasks without a live run.";
  }
  if (state.health.topology.status !== "fresh") {
    return "Refresh cmux topology before reviewing tasks without a live run.";
  }
  if (parkableCount === 0) return "No active tasks are currently missing a live run.";
  return "Select active tasks without a live cmux run and explicitly park them.";
}
