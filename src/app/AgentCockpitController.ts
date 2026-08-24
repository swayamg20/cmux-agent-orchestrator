import { Notice, type App, type Plugin } from "obsidian";
import { AgentDetector } from "../agents/AgentDetector";
import { FocusSessionAction } from "../actions/FocusSessionAction";
import { validateBinarySetting, validateBindingIdentity } from "../actions/validators";
import { BindingRepository } from "../bindings/BindingRepository";
import type { BindingRecord } from "../bindings/types";
import { CMUX_SETUP_CLIPBOARD_TEXT } from "../cmux/accessSetup";
import { CmuxClient } from "../cmux/CmuxClient";
import { CmuxError, type CmuxPreview, type CmuxSurface } from "../cmux/types";
import { CreateTaskModal, TaskPickerModal } from "../components/TaskModals";
import { AttentionEngine } from "../runtime/AttentionEngine";
import { PreviewScheduler } from "../runtime/PreviewScheduler";
import { RuntimeStateEngine } from "../runtime/RuntimeStateEngine";
import { buildLiveSessions } from "../runtime/types";
import {
  parseSettings,
  type AgentCockpitSettings
} from "../settings/AgentCockpitSettings";
import { CockpitStore } from "../state/CockpitStore";
import type {
  LiveSession,
  ProviderDetection,
  SessionFilters
} from "../state/types";
import type { CreateTaskOptions } from "../tasks/TaskRepository";
import { TaskRepository } from "../tasks/TaskRepository";
import type { TaskRecord, WorkflowStatus } from "../tasks/TaskSchema";

export type CmuxClientFactory = (explicitBinaryPath: string) => Promise<CmuxClient>;

const PROVIDER_EVIDENCE_LINES = 500;
const PROVIDER_EVIDENCE_MAX_BYTES = 64 * 1024;

export class AgentCockpitController {
  readonly store = new CockpitStore();

  private readonly bindings: BindingRepository;
  private readonly detector = new AgentDetector();
  private readonly runtimeEngine = new RuntimeStateEngine();
  private readonly attentionEngine = new AttentionEngine();
  private readonly previewScheduler = new PreviewScheduler(2);
  private readonly previews = new Map<string, CmuxPreview>();
  private readonly providerEvidence = new Map<string, ProviderDetection>();
  private client: CmuxClient | null = null;
  private focusAction: FocusSessionAction | null = null;
  private taskRepository: TaskRepository | null = null;
  private settings: AgentCockpitSettings | null = null;
  private topologyRefresh: Promise<void> | null = null;
  private notificationRefresh: Promise<void> | null = null;
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
      bindings: this.bindings.list()
    });
    await this.connect();
    if (this.client !== null) {
      this.store.update({ refreshing: true });
      try {
        await this.refreshSnapshot();
        if (this.store.getState().connection.status === "connected") {
          await this.refreshSessionEvidence();
        }
      } finally {
        this.store.update({ refreshing: false });
      }
    }
  }

  async refreshNow(): Promise<void> {
    if (this.disposed) return;
    this.store.update({ refreshing: true });
    try {
      if (this.client === null) await this.connect();
      if (this.client === null) return;
      await this.refreshSnapshot();
      if (this.store.getState().connection.status === "connected") {
        await this.refreshSessionEvidence();
      }
    } catch (error) {
      this.handleError(error);
    } finally {
      this.store.update({ refreshing: false });
    }
  }

  private async refreshSnapshot(): Promise<void> {
    await Promise.all([this.refreshTopology(), this.refreshNotifications()]);
  }

  private async refreshSessionEvidence(): Promise<void> {
    const client = this.requireClient();
    const settings = this.requireSettings();
    const sessions = this.store.getState().sessions.filter((session) => session.surfaceType === "terminal");
    for (const session of sessions) this.providerEvidence.delete(session.key);
    const results = await Promise.allSettled(
      sessions.map((session) =>
        this.previewScheduler
          .schedule(session.key, () =>
            client.readPreview(session, {
              lines: settings.previewLines,
              maxBytes: settings.previewMaxBytes
            })
          )
          .then((preview) => ({ key: session.key, preview }))
      )
    );
    if (this.disposed) return;
    for (const result of results) {
      if (result.status === "fulfilled") this.previews.set(result.value.key, result.value.preview);
    }
    this.recomputeSessions();
    const unresolved = this.store
      .getState()
      .sessions.filter(
        (session) => session.surfaceType === "terminal" && session.provider.provider === "unknown"
      );
    await this.refreshProviderEvidence(unresolved);
  }

  private async refreshProviderEvidence(sessions: readonly LiveSession[]): Promise<void> {
    if (sessions.length === 0) return;
    const client = this.requireClient();
    for (const session of sessions) this.providerEvidence.delete(session.key);
    const results = await Promise.allSettled(
      sessions.map((session) =>
        this.previewScheduler
          .schedule(`provider:${session.key}`, () =>
            client.readPreview(session, {
              lines: PROVIDER_EVIDENCE_LINES,
              maxBytes: PROVIDER_EVIDENCE_MAX_BYTES
            })
          )
          .then((preview) => ({ session, preview }))
      )
    );
    if (this.disposed) return;
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const detection = this.detector.detect(
        surfaceForDetection(result.value.session),
        result.value.preview.text
      );
      if (detection.provider === "claude" || detection.provider === "codex") {
        this.providerEvidence.set(result.value.session.key, detection);
      }
    }
    this.recomputeSessions();
  }

  refreshTopology(signal?: AbortSignal): Promise<void> {
    if (this.topologyRefresh !== null) return this.topologyRefresh;
    const refresh = this.performTopologyRefresh(signal).finally(() => {
      if (this.topologyRefresh === refresh) this.topologyRefresh = null;
    });
    this.topologyRefresh = refresh;
    return refresh;
  }

  private async performTopologyRefresh(signal?: AbortSignal): Promise<void> {
    const client = this.client;
    if (client === null) return;
    try {
      const snapshot = await client.snapshot(signal);
      this.store.update({
        snapshot,
        lastRefreshAt: snapshot.observedAt,
        error: null,
        connection: {
          ...this.store.getState().connection,
          status: "connected",
          message: connectionMessage(this.store.getState().connection.accessMode),
          checkedAt: snapshot.observedAt
        }
      });
      this.recomputeSessions();
    } catch (error) {
      this.handleError(error);
    }
  }

  refreshNotifications(signal?: AbortSignal): Promise<void> {
    if (this.notificationRefresh !== null) return this.notificationRefresh;
    const refresh = this.performNotificationRefresh(signal).finally(() => {
      if (this.notificationRefresh === refresh) this.notificationRefresh = null;
    });
    this.notificationRefresh = refresh;
    return refresh;
  }

  private async performNotificationRefresh(signal?: AbortSignal): Promise<void> {
    const client = this.client;
    if (client === null) return;
    try {
      const notifications = await client.notifications(signal);
      this.store.update({ notifications });
      this.recomputeSessions();
    } catch (error) {
      this.handleError(error);
    }
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
      this.providerEvidence.delete(session.key);
      this.previews.set(session.key, preview);
      this.recomputeSessions();
      const refreshed = this.store
        .getState()
        .sessions.find((candidate) => candidate.key === session.key);
      if (refreshed?.provider.provider === "unknown") {
        await this.refreshProviderEvidence([refreshed]);
      }
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
          : "cmux accepted the focus command, but Agent Cockpit could not verify the selected surface."
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
      const existingBinding = this.bindings.findBySurface(session.surfaceId);
      const binding: BindingRecord = {
        taskId: task.taskId,
        workspaceId: session.workspaceId,
        paneId: session.paneId,
        surfaceId: session.surfaceId,
        provider: session.provider.provider,
        providerSessionId: session.provider.sessionId,
        attachedAt: new Date().toISOString()
      };
      await this.bindings.attach(binding);
      this.store.update({ bindings: this.bindings.list() });
      if (existingBinding?.taskId !== task.taskId) {
        try {
          const runCount = await this.requireTaskRepository().incrementRunCount(task);
          this.store.update((state) => ({
            tasks: state.tasks.map((candidate) =>
              candidate.taskId === task.taskId
                ? { ...candidate, runCount, updatedAt: new Date().toISOString() }
                : candidate
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
    this.store.update({ bindings: this.bindings.list() });
    this.recomputeSessions();
    new Notice("Detached the session. The task note was not changed.");
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
      runtime: session.runtime,
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
      this.client?.dispose();
      this.client = null;
      this.focusAction = null;
      await this.connect();
    }
    await this.reloadTasks();
  }

  async testConnection(): Promise<void> {
    if (this.disposed || this.store.getState().refreshing) return;
    this.client?.dispose();
    this.client = null;
    this.focusAction = null;
    await this.refreshNow();
    const connection = this.store.getState().connection;
    new Notice(connection.message);
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
    this.previewScheduler.dispose();
    this.client?.dispose();
    this.client = null;
    this.runtimeEngine.clear();
    this.attentionEngine.clear();
    this.previews.clear();
    this.providerEvidence.clear();
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
      this.store.update({
        connection: {
          status: "connected",
          message: connectionMessage(probe.capabilities.accessMode),
          versionText: probe.versionText,
          accessMode: probe.capabilities.accessMode,
          binaryPath: probe.binaryPath,
          checkedAt: Date.now()
        },
        error: null
      });
    } catch (error) {
      this.client?.dispose();
      this.client = null;
      this.focusAction = null;
      this.handleError(error);
    }
  }

  private recomputeSessions(): void {
    const state = this.store.getState();
    if (state.snapshot === null) {
      this.providerEvidence.clear();
      this.store.update({ sessions: [], attention: [] });
      return;
    }
    const sessions = buildLiveSessions({
      snapshot: state.snapshot,
      notifications: state.notifications,
      bindings: state.bindings,
      previews: this.previews,
      detector: this.detector,
      runtimeEngine: this.runtimeEngine,
      staleAfterMs: this.requireSettings().staleAfterMs
    }).map((session) => {
      const evidence = this.providerEvidence.get(session.key);
      return session.provider.provider === "unknown" && evidence !== undefined
        ? { ...session, provider: evidence }
        : session;
    });
    const liveKeys = new Set(sessions.map((session) => session.key));
    for (const key of this.previews.keys()) {
      if (!liveKeys.has(key)) this.previews.delete(key);
    }
    for (const key of this.providerEvidence.keys()) {
      if (!liveKeys.has(key)) this.providerEvidence.delete(key);
    }
    const attention = this.attentionEngine.build(sessions, state.tasks, state.bindings, Date.now());
    this.store.update({ sessions, attention });
  }

  private handleError(error: unknown, connectionFailure = true): void {
    if (error instanceof CmuxError && error.code === "aborted") return;
    const message = readableError(error);
    if (!connectionFailure) {
      this.store.update({ error: message });
      return;
    }
    const status =
      error instanceof CmuxError && error.code === "access-blocked"
        ? "access-blocked"
        : error instanceof CmuxError && error.code === "cmux-not-running"
          ? "disconnected"
          : "error";
    this.store.update({
      connection: {
        ...this.store.getState().connection,
        status,
        message,
        checkedAt: Date.now()
      },
      error: message
    });
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

function surfaceForDetection(session: LiveSession): CmuxSurface {
  return {
    id: session.surfaceId,
    paneId: session.paneId,
    index: session.surfaceIndex,
    indexInPane: session.surfaceIndex,
    title: session.surfaceTitle,
    type: session.surfaceType,
    selected: false,
    focused: false,
    active: false
  };
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : "An unknown Agent Cockpit error occurred.";
}

function connectionMessage(accessMode: string | null): string {
  if (accessMode === "cmuxOnly") {
    return "Connected through cmux process-only access. Complete the one-time access setup before relying on normal Finder, Dock, or Spotlight launches.";
  }
  if (accessMode === "automation") return "Connected through cmux Automation mode.";
  if (accessMode === "password") {
    return "Connected through cmux Password mode. The socket password remains owned by cmux.";
  }
  if (accessMode === "allowAll") {
    return "Connected through cmux Full open access. Switch to Password or Automation mode to restrict local access.";
  }
  return "Connected to cmux.";
}
