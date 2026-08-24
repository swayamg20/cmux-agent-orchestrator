import { Notice, type App, type Plugin } from "obsidian";
import { FocusSessionAction } from "../actions/FocusSessionAction";
import { validateBinarySetting, validateBindingIdentity } from "../actions/validators";
import { AgentDetector } from "../agents/AgentDetector";
import { ProviderClassifier } from "../agents/ProviderClassifier";
import { BindingRepository } from "../bindings/BindingRepository";
import { CMUX_SETUP_CLIPBOARD_TEXT } from "../cmux/accessSetup";
import { CmuxClient } from "../cmux/CmuxClient";
import {
  CmuxError,
  type CmuxNotification,
  type CmuxSnapshot
} from "../cmux/types";
import { CreateTaskModal, TaskPickerModal } from "../components/TaskModals";
import { CmuxEvidenceService } from "../evidence/CmuxEvidenceService";
import { AttentionEngine } from "../runtime/AttentionEngine";
import { PreviewCache } from "../runtime/PreviewCache";
import { PreviewScheduler } from "../runtime/PreviewScheduler";
import { projectLiveSessions } from "../runtime/SessionProjection";
import { parseSettings, type AgentCockpitSettings } from "../settings/AgentCockpitSettings";
import { CockpitStore } from "../state/CockpitStore";
import type {
  ConnectionState,
  LiveSession,
  SessionFilters,
  SourceHealth
} from "../state/types";
import type { CreateTaskOptions } from "../tasks/TaskRepository";
import { TaskRepository } from "../tasks/TaskRepository";
import type { TaskRecord, WorkflowStatus } from "../tasks/TaskSchema";
import { RefreshCoordinator, type RefreshResult } from "./RefreshCoordinator";

export type CmuxClientFactory = (explicitBinaryPath: string) => Promise<CmuxClient>;

export class AgentCockpitController {
  readonly store = new CockpitStore();

  private readonly bindings: BindingRepository;
  private readonly detector = new AgentDetector();
  private readonly attentionEngine = new AttentionEngine();
  private readonly previewScheduler = new PreviewScheduler(2);
  private readonly previewCache = new PreviewCache();
  private readonly providerClassifier = new ProviderClassifier(this.detector, this.previewScheduler);
  private readonly evidence = new CmuxEvidenceService(this.detector);
  private readonly refreshCoordinator = new RefreshCoordinator();
  private classificationWork: Promise<void> = Promise.resolve();
  private client: CmuxClient | null = null;
  private focusAction: FocusSessionAction | null = null;
  private taskRepository: TaskRepository | null = null;
  private settings: AgentCockpitSettings | null = null;
  private disposed = false;

  constructor(
    private readonly app: App,
    private readonly plugin: Plugin,
    private readonly createClient: CmuxClientFactory = CmuxClient.create
  ) {
    this.bindings = new BindingRepository(plugin);
  }

  async initialize(): Promise<void> {
    await this.bindings.load();
    this.settings = this.bindings.getSettings();
    this.taskRepository = new TaskRepository(this.app, this.settings.taskFolder);
    this.store.update({
      tasks: this.taskRepository.list(),
      bindings: this.bindings.list(),
      runs: this.bindings.listRuns()
    });
    await this.connect();
    if (this.client !== null) await this.refreshNow();
  }

  async refreshNow(): Promise<void> {
    if (this.disposed) return;
    this.store.update({ refreshing: true });
    try {
      if (this.client === null) await this.connect();
      const client = this.client;
      if (client === null) return;
      const result = await this.refreshCoordinator.refresh({
        topology: (signal) => client.snapshot(signal),
        notifications: (signal) => client.notifications(signal)
      });
      this.applyRefreshResult(result);
      if (result.current && result.snapshot !== null) this.scheduleProviderClassification();
    } catch (error) {
      this.handleError(error);
    } finally {
      if (!this.disposed) this.store.update({ refreshing: false });
    }
  }

  async refreshTopology(signal?: AbortSignal): Promise<void> {
    const client = this.client;
    if (client === null || this.disposed) return;
    try {
      const snapshot = await client.snapshot(signal);
      this.applyTopology(snapshot);
      this.scheduleProviderClassification();
    } catch (error) {
      if (isAbort(error)) return;
      this.applyTopologyFailure(error);
    }
  }

  async refreshNotifications(signal?: AbortSignal): Promise<void> {
    const client = this.client;
    if (client === null || this.disposed) return;
    try {
      const notifications = await client.notifications(signal);
      this.applyNotifications(notifications);
    } catch (error) {
      if (isAbort(error)) return;
      this.applyNotificationFailure(error);
    }
  }

  async waitForBackgroundWork(): Promise<void> {
    await this.classificationWork;
  }

  async loadPreview(session: LiveSession): Promise<void> {
    const client = this.requireClient();
    const settings = this.requireSettings();
    try {
      const preview = await this.previewScheduler.schedule(session.key, () =>
        client.readPreview(session, {
          lines: settings.previewLines,
          maxBytes: settings.previewMaxBytes
        })
      );
      if (this.disposed) return;
      this.previewCache.set(session.key, preview);
      this.evidence.recordPreview(session.key, preview);
      const detection = this.providerClassifier.detect(session, preview.text);
      if (detection.provider === "claude" || detection.provider === "codex") {
        this.evidence.recordProvider(session.key, detection, preview.observedAt);
      }
      this.recomputeSessions();
    } catch (error) {
      this.handleError(error, false);
      new Notice(readableError(error));
    }
  }

  async focusSession(session: LiveSession): Promise<void> {
    if (this.focusAction === null) throw new Error("cmux connection is not initialized.");
    try {
      const result = await this.focusAction.execute(this.store.getState().connection, session);
      new Notice(
        result.verified
          ? `Focused ${result.target.workspaceTitle} / ${result.target.surfaceTitle} in cmux.`
          : "cmux accepted the focus command, but the selected surface could not be verified within the bounded retry window."
      );
    } catch (error) {
      this.handleError(error, false);
      new Notice(readableError(error));
    }
  }

  showTaskPicker(session: LiveSession): void {
    const modal = new TaskPickerModal(this.app, this.store.getState().tasks, (task) => {
      void this.attachTask(session, task).catch(() => undefined);
    });
    modal.open();
  }

  showCreateTask(session: LiveSession | null): void {
    const modal = new CreateTaskModal(this.app, session, async (options) => {
      await this.createTask(options, session);
    });
    modal.open();
  }

  async attachTask(session: LiveSession, task: TaskRecord): Promise<void> {
    try {
      validateBindingIdentity(task.taskId, session);
      this.requireTaskRepository().findById(task.taskId);
      const attachedAt = new Date().toISOString();
      const result = await this.bindings.attach({
        taskId: task.taskId,
        workspaceId: session.workspaceId,
        paneId: session.paneId,
        surfaceId: session.surfaceId,
        provider: session.provider.provider,
        providerSessionId: session.provider.sessionId,
        attachedAt
      });
      this.store.update({ bindings: this.bindings.list(), runs: this.bindings.listRuns() });
      if (result.isNewRun) {
        try {
          const runCount = await this.requireTaskRepository().incrementRunCount(task);
          this.store.update((state) => ({
            tasks: state.tasks.map((candidate) =>
              candidate.taskId === task.taskId ? { ...candidate, runCount, updatedAt: attachedAt } : candidate
            )
          }));
        } catch (error) {
          new Notice(`Session attached, but run count was not updated: ${readableError(error)}`);
        }
      }
      this.recomputeSessions();
      new Notice(`Attached session to ${task.title}.`);
    } catch (error) {
      new Notice(readableError(error));
      throw error;
    }
  }

  async detachTask(session: LiveSession): Promise<void> {
    await this.bindings.detach(session.surfaceId);
    this.store.update({ bindings: this.bindings.list(), runs: this.bindings.listRuns() });
    this.recomputeSessions();
    new Notice("Detached the session. The task note and run history were not deleted.");
  }

  async createTask(options: CreateTaskOptions, session: LiveSession | null = null): Promise<TaskRecord> {
    try {
      const task = await this.requireTaskRepository().create(options);
      this.store.update((state) => ({ tasks: [task, ...state.tasks] }));
      if (session !== null) await this.attachTask(session, task);
      else new Notice(`Created ${task.title}.`);
      return task;
    } catch (error) {
      new Notice(readableError(error));
      throw error;
    }
  }

  async openTask(task: TaskRecord): Promise<void> {
    try {
      await this.requireTaskRepository().open(task);
    } catch (error) {
      new Notice(readableError(error));
    }
  }

  async updateWorkflow(task: TaskRecord, workflowStatus: WorkflowStatus): Promise<void> {
    try {
      await this.requireTaskRepository().updateWorkflow(task, workflowStatus);
      const updatedAt = new Date().toISOString();
      this.store.update((state) => ({
        tasks: state.tasks.map((candidate) =>
          candidate.taskId === task.taskId ? { ...candidate, workflowStatus, updatedAt } : candidate
        )
      }));
      this.recomputeSessions();
    } catch (error) {
      new Notice(readableError(error));
    }
  }

  async reloadTasks(): Promise<void> {
    if (this.taskRepository === null) return;
    this.store.update({ tasks: this.taskRepository.list() });
    this.recomputeSessions();
  }

  async copyMetadata(session: LiveSession): Promise<void> {
    const metadata = {
      workspaceId: session.workspaceId,
      paneId: session.paneId,
      surfaceId: session.surfaceId,
      workspaceTitle: session.workspaceTitle,
      surfaceTitle: session.surfaceTitle,
      repository: session.currentDirectory,
      provider: session.provider,
      assessment: session.assessment,
      linkedTaskId: session.linkedTaskId
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(metadata, null, 2));
      new Notice("Copied bounded session metadata.");
    } catch (error) {
      new Notice(`Could not copy session metadata: ${readableError(error)}`);
    }
  }

  setFilters(patch: Partial<SessionFilters>): void {
    this.store.update((state) => ({ filters: { ...state.filters, ...patch } }));
  }

  getSettings(): AgentCockpitSettings {
    return { ...this.requireSettings() };
  }

  async updateSettings(next: AgentCockpitSettings): Promise<void> {
    const current = this.requireSettings();
    const parsed = parseSettings({ ...next, cmuxBinaryPath: validateBinarySetting(next.cmuxBinaryPath) });
    await this.bindings.updateSettings(parsed);
    this.settings = parsed;
    this.requireTaskRepository().setTaskFolder(parsed.taskFolder);
    if (current.cmuxBinaryPath !== parsed.cmuxBinaryPath) {
      this.refreshCoordinator.dispose();
      this.client?.dispose();
      this.client = null;
      this.focusAction = null;
      await this.connect();
    }
    await this.reloadTasks();
  }

  async testConnection(): Promise<void> {
    if (this.disposed || this.store.getState().refreshing) return;
    this.refreshCoordinator.dispose();
    this.client?.dispose();
    this.client = null;
    this.focusAction = null;
    await this.refreshNow();
    new Notice(this.store.getState().connection.message);
  }

  async copyCmuxSetupSteps(): Promise<void> {
    try {
      await navigator.clipboard.writeText(CMUX_SETUP_CLIPBOARD_TEXT);
      new Notice("Copied the cmux connection setup steps.");
    } catch (error) {
      new Notice(`Could not copy setup steps: ${readableError(error)}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.refreshCoordinator.dispose();
    this.previewScheduler.dispose();
    this.client?.dispose();
    this.client = null;
    this.attentionEngine.clear();
    this.previewCache.clear();
    this.evidence.clear();
    this.providerClassifier.clear();
    this.store.clear();
  }

  private async connect(): Promise<void> {
    if (this.disposed) return;
    this.store.update({
      connection: {
        ...this.store.getState().connection,
        status: "connecting",
        message: "Connecting to cmux...",
        checkedAt: Date.now()
      }
    });
    try {
      this.client?.dispose();
      this.client = await this.createClient(this.requireSettings().cmuxBinaryPath);
      const probe = await this.client.probe();
      this.focusAction = new FocusSessionAction(this.client);
      const checkedAt = Date.now();
      this.store.update((state) => ({
        connection: {
          status: "connected",
          message: connectionMessage(probe.capabilities.accessMode),
          versionText: probe.versionText,
          accessMode: probe.capabilities.accessMode,
          binaryPath: probe.binaryPath,
          checkedAt
        },
        health: {
          ...state.health,
          lifecycle: {
            status: "unavailable",
            checkedAt,
            lastSuccessAt: null,
            message: "cmux 0.62.2 exposes topology and notifications, but no structured agent lifecycle stream."
          }
        },
        error: null
      }));
    } catch (error) {
      this.client?.dispose();
      this.client = null;
      this.focusAction = null;
      this.handleError(error);
    }
  }

  private applyRefreshResult(result: RefreshResult): void {
    if (!result.current || this.disposed) return;
    this.store.batch(() => {
      if (result.snapshot !== null) this.applyTopology(result.snapshot);
      else if (result.topologyError !== null) this.applyTopologyFailure(result.topologyError);
      if (result.notifications !== null) this.applyNotifications(result.notifications);
      else if (result.notificationError !== null) this.applyNotificationFailure(result.notificationError);
    });
  }

  private applyTopology(snapshot: CmuxSnapshot): void {
    const checkedAt = snapshot.observedAt;
    this.store.update((state) => ({
      snapshot,
      lastRefreshAt: checkedAt,
      connection: {
        ...state.connection,
        status: "connected",
        message: connectionMessage(state.connection.accessMode),
        checkedAt
      },
      health: {
        ...state.health,
        topology: freshHealth(checkedAt, "cmux topology loaded.")
      },
      error: null
    }));
    this.recomputeSessions();
  }

  private applyNotifications(notifications: CmuxNotification[]): void {
    const checkedAt = Date.now();
    this.store.update((state) => ({
      notifications,
      health: {
        ...state.health,
        notifications: freshHealth(checkedAt, "cmux notifications loaded.")
      },
      error: null
    }));
    this.recomputeSessions();
  }

  private applyTopologyFailure(error: unknown): void {
    const checkedAt = Date.now();
    const message = readableError(error);
    this.store.update((state) => ({
      connection: connectionAfterError(state.connection, error, checkedAt),
      health: {
        ...state.health,
        topology: failedHealth(state.health.topology, checkedAt, message, state.snapshot !== null)
      },
      error: message
    }));
  }

  private applyNotificationFailure(error: unknown): void {
    const checkedAt = Date.now();
    const message = readableError(error);
    this.store.update((state) => ({
      health: {
        ...state.health,
        notifications: failedHealth(
          state.health.notifications,
          checkedAt,
          message,
          state.health.notifications.lastSuccessAt !== null
        )
      },
      error: `Notifications unavailable: ${message}`
    }));
  }

  private recomputeSessions(): void {
    const state = this.store.getState();
    if (state.snapshot === null) {
      this.store.update({ sessions: [], attention: [] });
      return;
    }
    this.syncCurrentEvidence(state.snapshot, state.notifications);
    const sessions = projectLiveSessions({
      snapshot: state.snapshot,
      notifications: state.notifications,
      bindings: state.bindings,
      detector: this.detector,
      providerEvidence: this.providerClassifier.evidence,
      previewFor: (key) => this.previewCache.peek(key),
      evidenceFor: (key) => this.evidence.list(key)
    });
    const attention = this.attentionEngine.build(sessions, state.tasks, state.bindings, Date.now());
    this.store.update({ sessions, attention });
  }

  private syncCurrentEvidence(snapshot: CmuxSnapshot, notifications: readonly CmuxNotification[]): void {
    const notificationObservedAt =
      this.store.getState().health.notifications.lastSuccessAt ?? snapshot.observedAt;
    const liveKeys = this.evidence.sync(snapshot, notifications, notificationObservedAt);
    this.previewCache.retain(liveKeys);
    this.providerClassifier.retain(liveKeys);
  }

  private scheduleProviderClassification(): void {
    if (this.disposed || this.client === null) return;
    const classification = this.providerClassifier.classifyNew(this.store.getState().sessions, this.client);
    if (classification === null) return;
    const work = classification.then((observations) => {
      if (this.disposed) return;
      this.store.batch(() => {
        for (const observation of observations) {
          this.evidence.recordProvider(observation.key, observation.detection, observation.observedAt);
        }
        this.recomputeSessions();
      });
    });
    this.classificationWork = Promise.all([this.classificationWork.catch(() => undefined), work]).then(() => undefined);
  }

  private handleError(error: unknown, connectionFailure = true): void {
    if (isAbort(error)) return;
    const message = readableError(error);
    if (!connectionFailure) {
      this.store.update({ error: message });
      return;
    }
    const checkedAt = Date.now();
    this.store.update((state) => ({
      connection: connectionAfterError(state.connection, error, checkedAt),
      error: message
    }));
  }

  private requireClient(): CmuxClient {
    if (this.client === null) throw new CmuxError("cmux-not-running", "Agent Cockpit is not connected to cmux.");
    return this.client;
  }

  private requireSettings(): AgentCockpitSettings {
    if (this.settings === null) throw new Error("Agent Cockpit settings are not loaded.");
    return this.settings;
  }

  private requireTaskRepository(): TaskRepository {
    if (this.taskRepository === null) throw new Error("Task repository is not initialized.");
    return this.taskRepository;
  }
}

function freshHealth(checkedAt: number, message: string): SourceHealth {
  return { status: "fresh", checkedAt, lastSuccessAt: checkedAt, message };
}

function failedHealth(
  previous: SourceHealth,
  checkedAt: number,
  message: string,
  hasUsableData: boolean
): SourceHealth {
  return {
    status: hasUsableData ? "stale" : "unavailable",
    checkedAt,
    lastSuccessAt: previous.lastSuccessAt,
    message
  };
}

function connectionAfterError(connection: ConnectionState, error: unknown, checkedAt: number): ConnectionState {
  const status =
    error instanceof CmuxError && error.code === "access-blocked"
      ? "access-blocked"
      : error instanceof CmuxError && error.code === "cmux-not-running"
        ? "disconnected"
        : "error";
  return { ...connection, status, message: readableError(error), checkedAt };
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : "An unknown Agent Cockpit error occurred.";
}

function isAbort(error: unknown): boolean {
  return error instanceof CmuxError && error.code === "aborted";
}

function connectionMessage(accessMode: string | null): string {
  if (accessMode === "cmuxOnly") {
    return "Connected through cmux process-only access. Complete the one-time access setup before relying on normal Finder, Dock, or Spotlight launches.";
  }
  if (accessMode === "automation") return "Connected through cmux Automation mode.";
  if (accessMode === "password") return "Connected through cmux Password mode. The socket password remains owned by cmux.";
  if (accessMode === "allowAll") {
    return "Connected through cmux Full open access. Switch to Password or Automation mode to restrict local access.";
  }
  return "Connected to cmux.";
}
