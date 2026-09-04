import { Notice, type App, type Modal, type Plugin } from "obsidian";
import { FocusSessionAction } from "../actions/FocusSessionAction";
import { validateBinarySetting, validateBindingIdentity } from "../actions/validators";
import { AgentDetector } from "../agents/AgentDetector";
import {
  ProviderClassifier,
  type ProviderSurfaceIdentity
} from "../agents/ProviderClassifier";
import { BindingRepository } from "../bindings/BindingRepository";
import type { BindingRecord, ProviderSessionMapping } from "../bindings/types";
import { CMUX_SETUP_CLIPBOARD_TEXT } from "../cmux/accessSetup";
import { CmuxClient } from "../cmux/CmuxClient";
import {
  CmuxError,
  surfaceKey,
  type CmuxNotification,
  type CmuxSnapshot
} from "../cmux/types";
import { CreateTaskModal, TaskPickerModal } from "../components/TaskModals";
import { ConversationPickerModal } from "../components/ConversationPickerModal";
import { CmuxEvidenceService } from "../evidence/CmuxEvidenceService";
import { PRODUCT_NAME } from "../identity";
import { ProviderMetadataService } from "../providers/ProviderMetadataService";
import type { ProviderSessionMetadata, ProviderSessionReference } from "../providers/types";
import type {
  AutomaticProviderSessionMapping,
  ProviderIdentityResolution,
  ProviderSessionResolver
} from "../providers/identity/types";
import { NOOP_PROVIDER_SESSION_RESOLVER } from "../providers/identity/types";
import { AttentionEngine } from "../runtime/AttentionEngine";
import { PreviewCache } from "../runtime/PreviewCache";
import { PreviewScheduler } from "../runtime/PreviewScheduler";
import { projectLiveSessions } from "../runtime/SessionProjection";
import {
  canonicalUuidEquals,
  isCanonicalUuid,
  normalizeCanonicalUuid
} from "../security/identifiers";
import {
  DEFAULT_SETTINGS,
  parseSettings,
  type AgentCockpitSettings
} from "../settings/AgentCockpitSettings";
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
import {
  automaticTaskId,
  automaticTaskTitle,
  bindingConflictsWithExactProviderIdentity,
  exactTrackableIdentity,
  providerSessionKey,
  selectAutomaticTrackCandidates,
  type AutomaticTrackCandidate
} from "../tracking/AutomaticTaskTracking";
import { RefreshCoordinator, type RefreshResult } from "./RefreshCoordinator";

export type CmuxClientFactory = (explicitBinaryPath: string) => Promise<CmuxClient>;

interface AutomaticTrackingPass {
  messages: Set<string>;
  failedIssueKeys: Set<string>;
}

export class AgentCockpitController {
  readonly store = new CockpitStore();

  private readonly bindings: BindingRepository;
  private readonly detector = new AgentDetector();
  private readonly attentionEngine = new AttentionEngine();
  private readonly previewScheduler = new PreviewScheduler(2);
  private readonly previewCache = new PreviewCache();
  private readonly previewSurfaceSignatures = new Map<string, string>();
  private readonly providerClassifier = new ProviderClassifier(this.detector, this.previewScheduler);
  private readonly evidence = new CmuxEvidenceService(this.detector);
  private readonly refreshCoordinator = new RefreshCoordinator();
  private classificationWork: Promise<void> = Promise.resolve();
  private metadataWork: Promise<void> = Promise.resolve();
  private identityWork: Promise<void> = Promise.resolve();
  private automaticTrackingWork: Promise<void> = Promise.resolve();
  private settingsUpdateWork: Promise<void> = Promise.resolve();
  private pendingSettingsUpdates = 0;
  private automaticTrackingGeneration = 0;
  private readonly reportedAutomaticTrackingIssues = new Map<string, string>();
  private readonly openModals = new Set<Modal>();
  private automaticTrackingPass: AutomaticTrackingPass | null = null;
  private identityAbortController: AbortController | null = null;
  private identityGeneration = 0;
  private automaticProviderMappings: AutomaticProviderSessionMapping[] = [];
  private client: CmuxClient | null = null;
  private clientGeneration = 0;
  private focusAction: FocusSessionAction | null = null;
  private taskRepository: TaskRepository | null = null;
  private settings: AgentCockpitSettings | null = null;
  private disposed = false;

  constructor(
    private readonly app: App,
    private readonly plugin: Plugin,
    private readonly createClient: CmuxClientFactory = (explicitBinaryPath) =>
      CmuxClient.create(explicitBinaryPath),
    private readonly providerMetadata = new ProviderMetadataService(),
    private readonly providerSessionResolver: ProviderSessionResolver = NOOP_PROVIDER_SESSION_RESOLVER
  ) {
    this.bindings = new BindingRepository(plugin);
  }

  async initialize(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.bindings.load();
    } catch (error) {
      if (this.disposed) return;
      throw error;
    }
    if (this.disposed) return;
    this.settings = this.bindings.getSettings();
    this.taskRepository = new TaskRepository(this.app, this.settings.taskFolder);
    this.store.update({
      tasks: this.taskRepository.list(),
      bindings: this.bindings.list(),
      runs: this.bindings.listRuns()
    });
    await this.connect();
    if (this.disposed) return;
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
      if (result.current && result.snapshot !== null) {
        this.scheduleProviderClassification();
        this.scheduleProviderMetadataRefresh();
        this.scheduleProviderIdentityResolution(result.snapshot);
      }
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
      if (this.disposed) return;
      this.applyTopology(snapshot);
      this.scheduleProviderClassification();
      this.scheduleProviderMetadataRefresh();
      this.scheduleProviderIdentityResolution(snapshot);
    } catch (error) {
      if (this.disposed || isAbort(error)) return;
      this.applyTopologyFailure(error);
    }
  }

  async refreshNotifications(signal?: AbortSignal): Promise<void> {
    const client = this.client;
    if (client === null || this.disposed) return;
    try {
      const notifications = await client.notifications(signal);
      if (this.disposed) return;
      this.applyNotifications(notifications);
    } catch (error) {
      if (this.disposed || isAbort(error)) return;
      this.applyNotificationFailure(error);
    }
  }

  async waitForBackgroundWork(): Promise<void> {
    await this.identityWork;
    await Promise.all([this.classificationWork, this.metadataWork]);
    await this.automaticTrackingWork;
  }

  async loadPreview(session: LiveSession): Promise<void> {
    if (this.disposed) return;
    try {
      const client = this.requireClient();
      const clientGeneration = this.clientGeneration;
      const settings = this.requireSettings();
      const requested = this.resolveCurrentSession(session);
      const signature = previewSurfaceSignature(requested);
      if (previewSurfaceSignature(session) !== signature) {
        throw new Error("The cmux surface changed before its preview could be loaded. Refresh and try again.");
      }
      const preview = await this.previewScheduler.schedule(`preview:${clientGeneration}:${requested.key}:${signature}`, () =>
        client.readPreview(requested, {
          lines: settings.previewLines,
          maxBytes: settings.previewMaxBytes
        })
      );
      if (this.disposed) return;
      if (clientGeneration !== this.clientGeneration || client !== this.client) {
        new Notice("The cmux connection changed while its preview was loading. The stale preview was discarded.");
        return;
      }
      if (
        !canonicalUuidEquals(preview.workspaceId, requested.workspaceId) ||
        !canonicalUuidEquals(preview.surfaceId, requested.surfaceId)
      ) {
        throw new CmuxError("malformed-output", "cmux returned terminal output for a different surface.");
      }
      const current = this.findCurrentSession(requested);
      if (current === null || previewSurfaceSignature(current) !== signature) {
        new Notice("The cmux surface changed while its preview was loading. The stale preview was discarded.");
        return;
      }
      this.previewSurfaceSignatures.set(current.key, signature);
      this.previewCache.set(current.key, preview);
      this.evidence.recordPreview(current.key, preview);
      const detection = this.providerClassifier.detect(current, preview.text);
      if (
        detection !== null &&
        (detection.provider === "claude" || detection.provider === "codex")
      ) {
        this.evidence.recordProvider(current.key, detection, preview.observedAt);
      }
      this.recomputeSessions();
    } catch (error) {
      if (this.disposed) return;
      this.handleError(error, false);
      new Notice(readableError(error));
    }
  }

  async focusSession(session: LiveSession): Promise<void> {
    if (this.disposed) return;
    try {
      const focusAction = this.focusAction;
      if (focusAction === null) throw new Error("cmux connection is not initialized.");
      const result = await focusAction.execute(this.store.getState().connection, session);
      if (this.disposed) return;
      new Notice(
        result.verified
          ? `Focused ${result.target.workspaceTitle} / ${result.target.surfaceTitle} in cmux.`
          : "cmux accepted the focus command, but the selected surface could not be verified within the bounded retry window."
      );
    } catch (error) {
      if (this.disposed) return;
      this.handleError(error, false);
      new Notice(readableError(error));
    }
  }

  showTaskPicker(session: LiveSession): void {
    if (this.disposed) return;
    this.openModal((closed) =>
      new TaskPickerModal(
        this.app,
        this.store.getState().tasks,
        (task) => {
          void this.attachTask(session, task).catch(() => undefined);
        },
        closed
      )
    );
  }

  showCreateTask(session: LiveSession | null): void {
    if (this.disposed) return;
    this.openModal((closed) =>
      new CreateTaskModal(
        this.app,
        session,
        async (options) => {
          await this.createTask(options, session);
        },
        closed
      )
    );
  }

  async showConversationPicker(session: LiveSession): Promise<void> {
    if (this.disposed) return;
    if (session.provider.provider !== "claude" && session.provider.provider !== "codex") {
      new Notice("Detect Claude or Codex before choosing a provider conversation.");
      return;
    }
    if (session.currentDirectory === null) {
      new Notice("This cmux workspace does not expose an absolute working directory.");
      return;
    }
    try {
      new Notice(
        `Loading local ${session.provider.provider === "claude" ? "Claude" : "Codex"} conversation titles...`,
        2_500
      );
      const conversations = await this.providerMetadata.list(
        session.provider.provider,
        session.currentDirectory
      );
      if (this.disposed) return;
      if (conversations.length === 0) {
        new Notice(`No ${session.provider.provider === "claude" ? "Claude" : "Codex"} conversations were found for this repository.`);
        return;
      }
      this.openModal((closed) =>
        new ConversationPickerModal(
          this.app,
          conversations,
          (conversation) => {
            void this.matchConversation(session, conversation).catch(() => undefined);
          },
          closed
        )
      );
    } catch (error) {
      if (this.disposed) return;
      new Notice(readableError(error));
    }
  }

  async forgetConversation(session: LiveSession): Promise<void> {
    if (this.disposed) return;
    try {
      const current = this.resolveCurrentBindingSession(session);
      const mapping = this.bindings
        .listProviderSessions()
        .find(
          (candidate) =>
            canonicalUuidEquals(candidate.workspaceId, current.workspaceId) &&
            canonicalUuidEquals(candidate.paneId, current.paneId) &&
            canonicalUuidEquals(candidate.surfaceId, current.surfaceId)
        );
      if (!mapping) {
        new Notice("This surface has no saved provider conversation match.");
        return;
      }
      if (
        session.provider.source !== "provider-session-mapping" ||
        session.provider.sessionId === null ||
        mapping.provider !== session.provider.provider ||
        !canonicalUuidEquals(mapping.providerSessionId, session.provider.sessionId)
      ) {
        throw new Error("The provider conversation changed before its saved match could be forgotten.");
      }
      const forgotten = await this.bindings.forgetProviderSessionIfUnchanged(mapping);
      if (this.disposed) return;
      if (!forgotten) {
        throw new Error("The provider conversation changed before its saved match could be forgotten.");
      }
      this.providerMetadata.forget(mapping.provider, mapping.providerSessionId);
      this.store.update({ bindings: this.bindings.list(), runs: this.bindings.listRuns() });
      this.recomputeSessions();
      new Notice("Forgot the conversation match. The provider conversation and task were not deleted.");
    } catch (error) {
      if (this.disposed) return;
      new Notice(readableError(error));
    }
  }

  async attachTask(session: LiveSession, task: TaskRecord): Promise<void> {
    if (this.disposed) return;
    try {
      await this.attachTaskInternal(session, task);
      if (this.disposed) return;
      new Notice(`Attached session to ${task.title}.`);
    } catch (error) {
      if (this.disposed) return;
      new Notice(readableError(error));
      throw error;
    }
  }

  async detachTask(session: LiveSession): Promise<void> {
    if (this.disposed) return;
    try {
      const current = this.resolveCurrentBindingSession(session);
      const expected = this.bindings.findBySurface(current.surfaceId);
      if (
        expected === null ||
        session.linkedTaskId === null ||
        !canonicalUuidEquals(expected.taskId, session.linkedTaskId) ||
        !canonicalUuidEquals(expected.workspaceId, current.workspaceId) ||
        !canonicalUuidEquals(expected.paneId, current.paneId) ||
        !canonicalUuidEquals(expected.surfaceId, current.surfaceId)
      ) {
        throw new Error("The task binding changed before it could be detached. Refresh and try again.");
      }
      const detached = await this.bindings.detachIfUnchanged(expected);
      if (this.disposed) return;
      if (!detached) {
        throw new Error("The task binding changed before it could be detached. Refresh and try again.");
      }
      this.store.update({ bindings: this.bindings.list(), runs: this.bindings.listRuns() });
      this.recomputeSessions();
      new Notice("Detached the session. The task note and run history were not deleted.");
    } catch (error) {
      if (this.disposed) return;
      new Notice(readableError(error));
      throw error;
    }
  }

  async createTask(options: CreateTaskOptions, session: LiveSession | null = null): Promise<TaskRecord> {
    if (this.disposed) throw new Error(`${PRODUCT_NAME} is unloaded.`);
    try {
      const current = session === null ? null : this.resolveCurrentBindingSession(session);
      const task = await this.requireTaskRepository().create(options);
      if (this.disposed) return task;
      this.store.update((state) => ({ tasks: [task, ...state.tasks] }));
      if (current === null) {
        new Notice(`Created ${task.title}.`);
      } else {
        try {
          await this.attachTaskInternal(current, task);
          if (this.disposed) return task;
          new Notice(`Created ${task.title} and attached the session.`);
        } catch (error) {
          if (this.disposed) return task;
          new Notice(`Created ${task.title}, but could not attach the session: ${readableError(error)}`);
        }
      }
      return task;
    } catch (error) {
      if (!this.disposed) new Notice(readableError(error));
      throw error;
    }
  }

  async openTask(task: TaskRecord): Promise<void> {
    if (this.disposed) return;
    try {
      await this.requireTaskRepository().open(task);
    } catch (error) {
      if (this.disposed) return;
      new Notice(readableError(error));
    }
  }

  async updateWorkflow(task: TaskRecord, workflowStatus: WorkflowStatus): Promise<boolean> {
    if (this.disposed) return false;
    try {
      await this.requireTaskRepository().updateWorkflow(task, workflowStatus);
      if (this.disposed) return false;
      const updatedAt = new Date().toISOString();
      this.store.update((state) => ({
        tasks: state.tasks.map((candidate) =>
          candidate.taskId === task.taskId ? { ...candidate, workflowStatus, updatedAt } : candidate
        )
      }));
      this.recomputeSessions();
      return true;
    } catch (error) {
      if (!this.disposed) new Notice(readableError(error));
      return false;
    }
  }

  async reloadTasks(changedPaths: readonly string[] = []): Promise<void> {
    if (this.disposed || this.taskRepository === null) return;
    this.taskRepository.invalidatePaths(changedPaths);
    this.store.update({ tasks: this.taskRepository.list() });
    this.recomputeSessions();
  }

  async copyMetadata(session: LiveSession): Promise<void> {
    if (this.disposed) return;
    const metadata = {
      workspaceId: session.workspaceId,
      paneId: session.paneId,
      surfaceId: session.surfaceId,
      workspaceTitle: session.workspaceTitle,
      surfaceTitle: session.surfaceTitle,
      repository: session.currentDirectory,
      provider: session.provider,
      conversation: session.conversation,
      assessment: session.assessment,
      linkedTaskId: session.linkedTaskId
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(metadata, null, 2));
      if (this.disposed) return;
      new Notice("Copied bounded session metadata.");
    } catch (error) {
      if (this.disposed) return;
      new Notice(`Could not copy session metadata: ${readableError(error)}`);
    }
  }

  setFilters(patch: Partial<SessionFilters>): void {
    if (this.disposed) return;
    this.store.update((state) => ({ filters: { ...state.filters, ...patch } }));
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  getSettings(): AgentCockpitSettings {
    return { ...this.requireSettings() };
  }

  getLoadedTaskFolder(): string | null {
    return this.settings?.taskFolder ?? null;
  }

  async updateSettings(next: AgentCockpitSettings): Promise<void> {
    if (this.disposed) return;
    const parsed = parseSettings({ ...next, cmuxBinaryPath: validateBinarySetting(next.cmuxBinaryPath) });
    this.pendingSettingsUpdates += 1;
    this.cancelAutomaticTaskTracking();
    const operation = this.settingsUpdateWork
      .catch(() => undefined)
      .then(() => this.applySettingsUpdate(parsed));
    this.settingsUpdateWork = operation.then(
      () => undefined,
      () => undefined
    );
    try {
      await operation;
    } finally {
      this.pendingSettingsUpdates -= 1;
      if (this.pendingSettingsUpdates === 0 && this.settings?.autoTrackAgentRuns === true) {
        this.scheduleAutomaticTaskTracking();
      }
    }
  }

  private async applySettingsUpdate(parsed: AgentCockpitSettings): Promise<void> {
    if (this.disposed) return;
    const current = this.requireSettings();
    const cmuxBinaryChanged = current.cmuxBinaryPath !== parsed.cmuxBinaryPath;
    await this.bindings.updateSettings(parsed);
    if (this.disposed) return;
    this.settings = parsed;
    this.requireTaskRepository().setTaskFolder(parsed.taskFolder);
    if (cmuxBinaryChanged) {
      this.cancelIdentityResolution();
      this.automaticProviderMappings = [];
      this.refreshCoordinator.dispose();
      this.client?.dispose();
      this.client = null;
      this.focusAction = null;
      await this.connect();
      if (this.client !== null) await this.refreshNow();
    }
    await this.reloadTasks();
  }

  async testConnection(): Promise<void> {
    if (this.disposed || this.store.getState().refreshing) return;
    this.refreshCoordinator.dispose();
    this.cancelIdentityResolution();
    this.automaticProviderMappings = [];
    this.client?.dispose();
    this.client = null;
    this.focusAction = null;
    await this.refreshNow();
    if (this.disposed) return;
    new Notice(this.store.getState().connection.message);
  }

  async copyCmuxSetupSteps(): Promise<void> {
    if (this.disposed) return;
    try {
      await navigator.clipboard.writeText(CMUX_SETUP_CLIPBOARD_TEXT);
      if (this.disposed) return;
      new Notice("Copied the cmux connection setup steps.");
    } catch (error) {
      if (this.disposed) return;
      new Notice(`Could not copy setup steps: ${readableError(error)}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.closeOpenModals();
    this.clientGeneration += 1;
    this.cancelAutomaticTaskTracking();
    this.refreshCoordinator.dispose();
    this.previewScheduler.dispose();
    this.cancelIdentityResolution();
    this.client?.dispose();
    this.client = null;
    this.focusAction = null;
    this.providerSessionResolver.dispose();
    this.providerMetadata.dispose();
    this.attentionEngine.clear();
    this.previewCache.clear();
    this.previewSurfaceSignatures.clear();
    this.evidence.clear();
    this.providerClassifier.clear();
    this.reportedAutomaticTrackingIssues.clear();
    this.automaticTrackingPass = null;
    this.store.clear();
  }

  private openModal(create: (closed: () => void) => Modal): void {
    let modal: Modal | null = null;
    const closed = (): void => {
      if (modal !== null) this.openModals.delete(modal);
    };
    modal = create(closed);
    if (this.disposed) {
      modal.close();
      return;
    }
    this.openModals.add(modal);
    try {
      modal.open();
    } catch (error) {
      this.openModals.delete(modal);
      throw error;
    }
  }

  private closeOpenModals(): void {
    const modals = [...this.openModals];
    this.openModals.clear();
    for (const modal of modals) modal.close();
  }

  private async connect(): Promise<void> {
    if (this.disposed) return;
    const clientGeneration = ++this.clientGeneration;
    this.client?.dispose();
    this.client = null;
    this.focusAction = null;
    this.store.update({
      connection: {
        ...this.store.getState().connection,
        status: "connecting",
        message: "Connecting to cmux...",
        checkedAt: Date.now()
      }
    });
    let candidate: CmuxClient | null = null;
    try {
      candidate = await this.createClient(this.requireSettings().cmuxBinaryPath);
      if (this.disposed || clientGeneration !== this.clientGeneration) {
        candidate.dispose();
        return;
      }
      const probe = await candidate.probe();
      if (this.disposed || clientGeneration !== this.clientGeneration) {
        candidate.dispose();
        return;
      }
      this.client = candidate;
      this.focusAction = new FocusSessionAction(candidate);
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
            message: "Agent lifecycle capability will be feature-detected during refresh."
          }
        },
        error: null
      }));
    } catch (error) {
      candidate?.dispose();
      if (this.disposed || clientGeneration !== this.clientGeneration) return;
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
    if (this.disposed) return;
    // Every topology snapshot is a new authority boundary. Work selected from
    // the prior snapshot may finish creating a note, but it must not bind a
    // provider session after this point without being selected again.
    this.cancelAutomaticTaskTracking();
    const checkedAt = snapshot.observedAt;
    this.automaticProviderMappings = [];
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
        topology: freshHealth(checkedAt, "cmux topology loaded."),
        lifecycle: {
          status: state.health.lifecycle.lastSuccessAt === null ? "unavailable" : "stale",
          checkedAt,
          lastSuccessAt: state.health.lifecycle.lastSuccessAt,
          message: "Refreshing exact provider identity and lifecycle evidence."
        }
      },
      error: null
    }));
    const liveKeys = this.syncCurrentEvidence(snapshot, this.store.getState().notifications);
    this.evidence.recordLifecycle(liveKeys, []);
    this.recomputeSessions();
  }

  private applyNotifications(notifications: CmuxNotification[]): void {
    if (this.disposed) return;
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
    if (this.disposed) return;
    // A cached tree remains useful for display, but it is no longer current
    // enough to authorize automatic durable bindings.
    this.cancelIdentityResolution();
    this.cancelAutomaticTaskTracking();
    this.automaticProviderMappings = [];
    const checkedAt = Date.now();
    const message = readableError(error);
    this.store.update((state) => ({
      connection: connectionAfterError(state.connection, error, checkedAt),
      health: {
        ...state.health,
        topology: failedHealth(state.health.topology, checkedAt, message, state.snapshot !== null),
        lifecycle: failedHealth(
          state.health.lifecycle,
          checkedAt,
          `Exact provider identity is stale because cmux topology could not be refreshed: ${message}`,
          state.health.lifecycle.lastSuccessAt !== null
        )
      },
      error: message
    }));
  }

  private applyNotificationFailure(error: unknown): void {
    if (this.disposed) return;
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
    if (this.disposed) return;
    const state = this.store.getState();
    const snapshot = state.snapshot;
    if (snapshot === null) {
      this.store.update({ sessions: [], attention: [] });
      return;
    }
    this.syncCurrentEvidence(snapshot, state.notifications);
    const project = (): LiveSession[] =>
      projectLiveSessions({
        snapshot,
        notifications: state.notifications,
        bindings: state.bindings,
        providerMappings: this.bindings.listProviderSessions(),
        automaticProviderMappings: this.automaticProviderMappings,
        providerMetadata: this.providerMetadata.evidence,
        detector: this.detector,
        providerEvidence: this.providerClassifier.evidence,
        previewFor: (key) => this.previewCache.peek(key),
        evidenceFor: (key) => this.evidence.list(key)
      });
    let sessions = project();
    const invalidatedPreviews = new Set<string>();
    for (const session of sessions) {
      const storedSignature = this.previewSurfaceSignatures.get(session.key);
      if (
        storedSignature !== undefined &&
        storedSignature !== previewSurfaceSignature(session)
      ) {
        this.previewSurfaceSignatures.delete(session.key);
        this.previewCache.delete(session.key);
        invalidatedPreviews.add(session.key);
      }
    }
    if (invalidatedPreviews.size > 0) {
      this.evidence.clearPreviews(invalidatedPreviews);
      sessions = project();
    }
    const attention = this.attentionEngine.build(
      sessions,
      state.tasks,
      state.bindings,
      Date.now(),
      this.settings?.staleAfterMs ?? DEFAULT_SETTINGS.staleAfterMs
    );
    this.store.update({ sessions, attention });
  }

  private syncCurrentEvidence(
    snapshot: CmuxSnapshot,
    notifications: readonly CmuxNotification[]
  ): ReadonlySet<string> {
    const notificationObservedAt =
      this.store.getState().health.notifications.lastSuccessAt ?? snapshot.observedAt;
    const invalidatedProviders = this.providerClassifier.syncSurfaces(
      providerSurfaceIdentities(snapshot)
    );
    this.evidence.clearProviders(invalidatedProviders);
    this.evidence.clearPreviews(invalidatedProviders);
    for (const key of invalidatedProviders) {
      this.previewCache.delete(key);
      this.previewSurfaceSignatures.delete(key);
    }
    const liveKeys = this.evidence.sync(snapshot, notifications, notificationObservedAt);
    this.previewCache.retain(liveKeys);
    for (const key of this.previewSurfaceSignatures.keys()) {
      if (!liveKeys.has(key)) this.previewSurfaceSignatures.delete(key);
    }
    return liveKeys;
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

  private scheduleProviderMetadataRefresh(): void {
    if (this.disposed) return;
    const mappings = this.effectiveProviderMappings();
    if (mappings.length === 0) return;
    const work = this.providerMetadata
      .refreshMapped(mappings, this.store.getState().sessions)
      .then(() => {
        if (!this.disposed) {
          this.recomputeSessions();
          this.scheduleAutomaticTaskTracking();
        }
      });
    this.metadataWork = Promise.all([this.metadataWork.catch(() => undefined), work]).then(() => undefined);
  }

  private scheduleAutomaticTaskTracking(): void {
    if (
      this.disposed ||
      this.pendingSettingsUpdates > 0 ||
      this.settings?.autoTrackAgentRuns !== true
    ) {
      return;
    }
    const generation = this.automaticTrackingGeneration;
    this.automaticTrackingWork = this.automaticTrackingWork
      .catch(() => undefined)
      .then(async () => {
        const pass: AutomaticTrackingPass = {
          messages: new Set<string>(),
          failedIssueKeys: new Set<string>()
        };
        this.automaticTrackingPass = pass;
        try {
          await this.reconcileAutomaticTasks(generation);
          this.clearInactiveAutomaticTrackingIssues(pass.failedIssueKeys);
        } finally {
          if (this.automaticTrackingPass === pass) {
            this.automaticTrackingPass = null;
          }
        }
      })
      .then(() => {
        if (this.automaticTrackingAllowed(generation)) {
          this.clearAutomaticTrackingIssues("automatic-tracking");
        }
      })
      .catch((error: unknown) => {
        if (this.disposed) return;
        this.reportAutomaticTrackingIssue("automatic-tracking", error);
      });
  }

  private async reconcileAutomaticTasks(generation: number): Promise<void> {
    if (!this.automaticTrackingAllowed(generation) || this.taskRepository === null) return;

    const relocated = await this.relocateResumedProviderSessions(generation);
    let changed = relocated > 0;
    changed = (await this.repairAutomaticRunCounts(generation)) || changed;
    if (!this.automaticTrackingAllowed(generation)) {
      if (changed) this.publishAutomaticTrackingState();
      return;
    }
    const candidates = selectAutomaticTrackCandidates(
      this.store.getState().sessions,
      this.bindings.listRuns()
    );

    let tracked = 0;
    for (const candidate of candidates) {
      if (!this.automaticTrackingAllowed(generation)) break;
      const issueKey = providerSessionKey(candidate.provider, candidate.providerSessionId);
      try {
        let current = this.resolveCurrentAutomaticCandidate(candidate);
        if (current === null || this.hasProviderRun(candidate)) continue;
        let expectedBinding = this.bindings.findBySurface(current.surfaceId);
        if (
          expectedBinding !== null &&
          expectedBinding.provider === candidate.provider &&
          normalizeCanonicalUuid(expectedBinding.providerSessionId ?? "") ===
            candidate.providerSessionId
        ) {
          continue;
        }

        const currentSurfaceId = current.surfaceId;
        const staleManualMapping = this.bindings.listProviderSessions().find(
          (mapping) =>
            canonicalUuidEquals(mapping.surfaceId, currentSurfaceId) &&
            (mapping.provider !== candidate.provider ||
              !canonicalUuidEquals(mapping.providerSessionId, candidate.providerSessionId))
        );
        if (staleManualMapping !== undefined) {
          const discarded = await this.bindings.discardProviderSessionMappingIfUnchanged(
            staleManualMapping,
            () =>
              this.automaticTrackingAllowed(generation) &&
              this.resolveCurrentAutomaticCandidate(candidate) !== null &&
              !this.hasProviderRun(candidate)
          );
          if (!discarded) continue;
          changed = true;

          current = this.resolveCurrentAutomaticCandidate(candidate);
          if (current === null || this.hasProviderRun(candidate)) continue;
          expectedBinding = this.bindings.findBySurface(current.surfaceId);
        }

        const ensured = await this.taskRepository.ensure(
          {
            taskId: candidate.taskId,
            title: automaticTaskTitle(current, candidate.provider),
            workflowStatus: "active",
            priority: "normal",
            repository: current.currentDirectory,
            branch: null,
            worktree: null
          },
          () =>
            this.automaticTrackingAllowed(generation) &&
            this.resolveCurrentAutomaticCandidate(candidate) !== null &&
            !this.hasProviderRun(candidate)
        );
        if (ensured === null) {
          if (!this.automaticTrackingAllowed(generation)) break;
          continue;
        }
        changed ||= ensured.created;

        if (!this.automaticTrackingAllowed(generation)) break;

        // Vault writes are asynchronous. Resolve the exact target again before
        // persisting a machine-local cmux binding.
        current = this.resolveCurrentAutomaticCandidate(candidate);
        if (current === null || this.hasProviderRun(candidate)) continue;
        const task = this.taskRepository.findById(ensured.task.taskId);
        validateBindingIdentity(task.taskId, current);

        const attachedAt = new Date().toISOString();
        const result = await this.bindings.attachIfSurfaceUnchanged(
          {
            taskId: task.taskId,
            workspaceId: current.workspaceId,
            paneId: current.paneId,
            surfaceId: current.surfaceId,
            provider: candidate.provider,
            providerSessionId: candidate.providerSessionId,
            attachedAt
          },
          expectedBinding,
          () =>
            this.automaticTrackingAllowed(generation) &&
            this.resolveCurrentAutomaticCandidate(candidate) !== null &&
            !this.hasProviderRun(candidate)
        );
        if (result === null) continue;
        changed = true;
        if (result.isNewRun && this.automaticTrackingAllowed(generation)) {
          try {
            await this.persistNewRunCount(task);
          } catch (error) {
            this.reportAutomaticTrackingIssue(
              `${issueKey}:run-count`,
              automaticRunCountError(error)
            );
          }
        }
        tracked += 1;
        this.clearAutomaticTrackingIssues(issueKey);
      } catch (error) {
        this.reportAutomaticTrackingIssue(issueKey, error);
      }
    }

    if (changed) {
      this.publishAutomaticTrackingState();
    }
    if (this.disposed) return;
    if (tracked > 0) {
      new Notice(
        `Automatically tracked ${String(tracked)} exact agent ${tracked === 1 ? "run" : "runs"} on the Work board.`
      );
    }
    if (relocated > 0) {
      new Notice(
        `Reconnected ${String(relocated)} exact agent ${relocated === 1 ? "run" : "runs"} to existing Work ${relocated === 1 ? "task" : "tasks"}.`
      );
    }
  }

  private async relocateResumedProviderSessions(generation: number): Promise<number> {
    const repository = this.taskRepository;
    if (repository === null) return 0;
    const sessions = this.store.getState().sessions;
    const bindingsByProviderSession = new Map<string, BindingRecord[]>();
    for (const binding of this.bindings.list()) {
      if (
        (binding.provider !== "claude" && binding.provider !== "codex") ||
        binding.providerSessionId === null ||
        !isCanonicalUuid(binding.providerSessionId)
      ) {
        continue;
      }
      const key = providerSessionKey(binding.provider, binding.providerSessionId);
      const group = bindingsByProviderSession.get(key) ?? [];
      group.push(binding);
      bindingsByProviderSession.set(key, group);
    }

    let relocated = 0;
    for (const [identityKey, bindings] of bindingsByProviderSession) {
      if (!this.automaticTrackingAllowed(generation)) break;
      if (bindings.length !== 1) continue;
      const binding = bindings[0]!;
      const provider = binding.provider;
      const providerSessionId = normalizeCanonicalUuid(binding.providerSessionId ?? "");
      if ((provider !== "claude" && provider !== "codex") || providerSessionId === null) {
        continue;
      }
      const oldSurfaceStillExists = sessions.some(
        (session) =>
          canonicalUuidEquals(session.workspaceId, binding.workspaceId) &&
          canonicalUuidEquals(session.paneId, binding.paneId) &&
          canonicalUuidEquals(session.surfaceId, binding.surfaceId)
      );
      if (oldSurfaceStillExists) continue;

      const matches = sessions.filter((session) => {
        const identity = exactTrackableIdentity(session);
        return (
          identity !== null &&
          providerSessionKey(identity.provider, identity.sessionId) === identityKey &&
          session.linkedTaskId === null
        );
      });
      if (matches.length !== 1) continue;

      const issueKey = `${identityKey}:relocation`;
      try {
        let current = this.resolveUniqueUnlinkedProviderSession(
          matches[0]!,
          provider,
          providerSessionId
        );
        if (current === null) continue;
        const task = repository.findById(binding.taskId);
        validateBindingIdentity(task.taskId, current);

        // Re-resolve immediately before the machine-local binding mutation.
        current = this.resolveUniqueUnlinkedProviderSession(
          current,
          provider,
          providerSessionId
        );
        if (current === null) continue;
        const relocatedAt = new Date().toISOString();
        const result = await this.bindings.relocateProviderSession(
          {
            bindingId: binding.bindingId,
            runId: binding.runId,
            taskId: binding.taskId,
            provider,
            providerSessionId,
            fromWorkspaceId: binding.workspaceId,
            fromPaneId: binding.paneId,
            fromSurfaceId: binding.surfaceId,
            toWorkspaceId: current.workspaceId,
            toPaneId: current.paneId,
            toSurfaceId: current.surfaceId,
            relocatedAt
          },
          () =>
            this.automaticTrackingAllowed(generation) &&
            this.resolveUniqueUnlinkedProviderSession(
              current,
              provider,
              providerSessionId
            ) !== null
        );
        if (result === null) continue;
        relocated += 1;
        this.clearAutomaticTrackingIssues(issueKey);
      } catch (error) {
        this.reportAutomaticTrackingIssue(issueKey, error);
      }
    }
    return relocated;
  }

  private async repairAutomaticRunCounts(generation: number): Promise<boolean> {
    const repository = this.taskRepository;
    if (repository === null) return false;
    const tasks = new Map(repository.list().map((task) => [task.taskId, task] as const));
    let changed = false;

    for (const run of this.bindings.listRuns()) {
      if (!this.automaticTrackingAllowed(generation)) break;
      if (
        (run.provider !== "claude" && run.provider !== "codex") ||
        run.providerSessionId === null ||
        !isCanonicalUuid(run.providerSessionId) ||
        run.taskId !== automaticTaskId(run.provider, run.providerSessionId)
      ) {
        continue;
      }
      const task = tasks.get(run.taskId);
      if (task === undefined || task.runCount >= 1) continue;
      const issueKey = `${providerSessionKey(run.provider, run.providerSessionId)}:run-count`;
      try {
        const repaired = await repository.ensureRunCountAtLeast(
          task,
          1,
          () => this.automaticTrackingAllowed(generation)
        );
        if (repaired === null) break;
        changed = true;
        this.clearAutomaticTrackingIssues(issueKey);
      } catch (error) {
        this.reportAutomaticTrackingIssue(
          issueKey,
          automaticRunCountError(error)
        );
      }
    }
    return changed;
  }

  private automaticTrackingAllowed(generation: number): boolean {
    const state = this.store.getState();
    return (
      !this.disposed &&
      this.pendingSettingsUpdates === 0 &&
      this.settings?.autoTrackAgentRuns === true &&
      generation === this.automaticTrackingGeneration &&
      state.connection.status === "connected" &&
      state.health.topology.status === "fresh"
    );
  }

  private cancelAutomaticTaskTracking(): void {
    this.automaticTrackingGeneration += 1;
  }

  private publishAutomaticTrackingState(): void {
    if (this.disposed || this.taskRepository === null) return;
    this.store.update({
      tasks: this.taskRepository.list(),
      bindings: this.bindings.list(),
      runs: this.bindings.listRuns()
    });
    this.recomputeSessions();
  }

  private resolveCurrentAutomaticCandidate(candidate: AutomaticTrackCandidate): LiveSession | null {
    return this.resolveUniqueUnlinkedProviderSession(
      candidate.session,
      candidate.provider,
      candidate.providerSessionId
    );
  }

  private resolveUniqueUnlinkedProviderSession(
    original: LiveSession,
    provider: "claude" | "codex",
    providerSessionId: string
  ): LiveSession | null {
    const state = this.store.getState();
    const current = state.sessions.find(
      (session) =>
        canonicalUuidEquals(session.workspaceId, original.workspaceId) &&
        canonicalUuidEquals(session.paneId, original.paneId) &&
        canonicalUuidEquals(session.surfaceId, original.surfaceId)
    );
    if (current === undefined || current.linkedTaskId !== null) return null;

    const identity = exactTrackableIdentity(current);
    if (
      identity === null ||
      identity.provider !== provider ||
      identity.sessionId !== normalizeCanonicalUuid(providerSessionId)
    ) {
      return null;
    }

    const matchingSurfaces = state.sessions.filter((session) => {
      const other = exactTrackableIdentity(session);
      return (
        other?.provider === provider &&
        other.sessionId === identity.sessionId
      );
    });
    return matchingSurfaces.length === 1 ? current : null;
  }

  private hasProviderRun(candidate: AutomaticTrackCandidate): boolean {
    const key = providerSessionKey(candidate.provider, candidate.providerSessionId);
    return this.bindings.listRuns().some(
      (run) =>
        (run.provider === "claude" || run.provider === "codex") &&
        run.providerSessionId !== null &&
        providerSessionKey(run.provider, run.providerSessionId) === key
    );
  }

  private reportAutomaticTrackingIssue(key: string, error: unknown): void {
    if (this.disposed) return;
    const message = readableError(error);
    const pass = this.automaticTrackingPass;
    pass?.failedIssueKeys.add(key);
    const alreadyReportedForKey = this.reportedAutomaticTrackingIssues.get(key) === message;
    this.reportedAutomaticTrackingIssues.set(key, message);
    const alreadyReportedThisPass = pass?.messages.has(message) === true;
    pass?.messages.add(message);
    if (alreadyReportedForKey || alreadyReportedThisPass) return;
    new Notice(`Automatic task tracking could not finish: ${message}`);
  }

  private clearAutomaticTrackingIssues(key: string): void {
    this.automaticTrackingPass?.failedIssueKeys.delete(key);
    this.reportedAutomaticTrackingIssues.delete(key);
  }

  private clearInactiveAutomaticTrackingIssues(failedIssueKeys: ReadonlySet<string>): void {
    for (const key of this.reportedAutomaticTrackingIssues.keys()) {
      if (key !== "automatic-tracking" && !failedIssueKeys.has(key)) {
        this.reportedAutomaticTrackingIssues.delete(key);
      }
    }
  }

  private scheduleProviderIdentityResolution(snapshot: CmuxSnapshot): void {
    const client = this.client;
    if (this.disposed || client === null) return;
    this.cancelIdentityResolution();
    const controller = new AbortController();
    const generation = ++this.identityGeneration;
    this.identityAbortController = controller;
    const work = this.providerSessionResolver
      .resolve(snapshot, client, controller.signal)
      .then((resolution) => {
        if (
          this.disposed ||
          controller.signal.aborted ||
          generation !== this.identityGeneration ||
          this.store.getState().snapshot?.observedAt !== snapshot.observedAt
        ) {
          return;
        }
        this.applyIdentityResolution(snapshot, resolution);
        this.scheduleProviderMetadataRefresh();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || this.disposed) return;
        const checkedAt = Date.now();
        this.store.update((state) => ({
          health: {
            ...state.health,
            lifecycle: failedHealth(
              state.health.lifecycle,
              checkedAt,
              `Agent identity refresh failed: ${readableError(error)}`,
              state.health.lifecycle.lastSuccessAt !== null
            )
          }
        }));
      })
      .finally(() => {
        if (this.identityAbortController === controller) this.identityAbortController = null;
      });
    this.identityWork = work;
  }

  private applyIdentityResolution(
    snapshot: CmuxSnapshot,
    resolution: ProviderIdentityResolution
  ): void {
    this.automaticProviderMappings = resolution.mappings;
    const liveKeys = this.evidence.sync(
      snapshot,
      this.store.getState().notifications,
      this.store.getState().health.notifications.lastSuccessAt ?? snapshot.observedAt
    );
    this.evidence.recordLifecycle(liveKeys, resolution.lifecycle);
    const issueSuffix = resolution.issues.length > 0 ? ` ${resolution.issues.join(" ")}` : "";
    const lifecycle = resolution.nativeLifecycleAvailable
      ? freshHealth(
          resolution.checkedAt,
          `Structured cmux agent lifecycle is available.${issueSuffix}`.trim()
        )
      : resolution.lifecycle.length > 0
        ? freshHealth(
            resolution.checkedAt,
            `Local provider lifecycle metadata is available; cmux native lifecycle is unavailable.${issueSuffix}`.trim()
          )
        : {
            status: "unavailable" as const,
            checkedAt: resolution.checkedAt,
            lastSuccessAt: null,
            message: `This cmux build does not expose structured agent lifecycle. Automatic exact conversation matching remains available when local process evidence permits.${issueSuffix}`.trim()
          };
    this.store.update((state) => ({
      health: { ...state.health, lifecycle }
    }));
    this.recomputeSessions();
    this.scheduleAutomaticTaskTracking();
  }

  private cancelIdentityResolution(): void {
    this.identityGeneration += 1;
    this.identityAbortController?.abort();
    this.identityAbortController = null;
  }

  private effectiveProviderMappings(): ProviderSessionReference[] {
    const mappings = new Map<string, ProviderSessionReference>();
    const claimedProviderSessions = new Set<string>();
    const liveSessions = new Map(
      this.store.getState().sessions.map(
        (session) => [normalizeCanonicalUuid(session.surfaceId) ?? session.surfaceId, session] as const
      )
    );
    const addMapping = (mapping: ProviderSessionReference): void => {
      const surfaceId = normalizeCanonicalUuid(mapping.surfaceId);
      const providerSessionId = normalizeCanonicalUuid(mapping.providerSessionId);
      if (surfaceId === null || providerSessionId === null) return;
      const live = liveSessions.get(surfaceId);
      if (!live) return;
      if (
        !canonicalUuidEquals(live.workspaceId, mapping.workspaceId) ||
        !canonicalUuidEquals(live.paneId, mapping.paneId)
      ) {
        return;
      }
      const identityKey = providerSessionKey(mapping.provider, providerSessionId);
      if (mappings.has(surfaceId) || claimedProviderSessions.has(identityKey)) return;
      mappings.set(surfaceId, {
        ...mapping,
        workspaceId: live.workspaceId,
        paneId: live.paneId,
        surfaceId: live.surfaceId,
        providerSessionId
      });
      claimedProviderSessions.add(identityKey);
    };

    for (const mapping of this.bindings.listProviderSessions()) addMapping(mapping);
    for (const mapping of this.automaticProviderMappings) addMapping(mapping);
    for (const binding of this.bindings.list()) {
      if (
        (binding.provider !== "claude" && binding.provider !== "codex") ||
        binding.providerSessionId === null ||
        !isCanonicalUuid(binding.providerSessionId)
      ) {
        continue;
      }
      addMapping({
        workspaceId: binding.workspaceId,
        paneId: binding.paneId,
        surfaceId: binding.surfaceId,
        provider: binding.provider,
        providerSessionId: binding.providerSessionId,
        matchedAt: binding.attachedAt
      });
    }
    return [...mappings.values()];
  }

  private async matchConversation(
    original: LiveSession,
    conversation: ProviderSessionMetadata
  ): Promise<void> {
    if (this.disposed) return;
    try {
      const expectedMapping = this.expectedProviderSessionMapping(original);
      const current = this.resolveCurrentBindingSession(original);
      if (
        current.currentDirectory === null ||
        current.currentDirectory !== conversation.cwd ||
        current.provider.provider !== conversation.provider
      ) {
        throw new Error("The cmux surface no longer matches the selected provider conversation.");
      }
      const exactLiveIdentity = current.provider.source === "provider-session-mapping"
        ? null
        : exactTrackableIdentity(current);
      if (
        exactLiveIdentity !== null &&
        normalizeCanonicalUuid(conversation.sessionId) !== exactLiveIdentity.sessionId
      ) {
        throw new Error("The selected conversation conflicts with the exact live provider session.");
      }
      const mapping = {
        workspaceId: current.workspaceId,
        paneId: current.paneId,
        surfaceId: current.surfaceId,
        provider: conversation.provider,
        providerSessionId: conversation.sessionId,
        matchedAt: new Date().toISOString()
      };
      const matched = await this.bindings.mapProviderSessionIfUnchanged(mapping, expectedMapping);
      if (this.disposed) return;
      if (!matched) {
        throw new Error("The saved provider conversation changed while the picker was open. Refresh and try again.");
      }
      this.store.update({ bindings: this.bindings.list(), runs: this.bindings.listRuns() });
      this.recomputeSessions();
      this.scheduleAutomaticTaskTracking();
      new Notice(`Matched this cmux surface to “${conversation.title}”.`);
    } catch (error) {
      if (this.disposed) return;
      new Notice(readableError(error));
      throw error;
    }
  }

  private resolveCurrentSession(original: LiveSession): LiveSession {
    const current = this.findCurrentSession(original);
    if (!current) throw new Error("The exact cmux surface no longer exists. Refresh and try again.");
    return current;
  }

  private findCurrentSession(original: LiveSession): LiveSession | null {
    return this.store
      .getState()
      .sessions.find(
        (candidate) =>
          canonicalUuidEquals(candidate.workspaceId, original.workspaceId) &&
          canonicalUuidEquals(candidate.paneId, original.paneId) &&
          canonicalUuidEquals(candidate.surfaceId, original.surfaceId)
      ) ?? null;
  }

  private expectedProviderSessionMapping(original: LiveSession): ProviderSessionMapping | null {
    const mapping = this.bindings
      .listProviderSessions()
      .find(
        (candidate) =>
          canonicalUuidEquals(candidate.workspaceId, original.workspaceId) &&
          canonicalUuidEquals(candidate.paneId, original.paneId) &&
          canonicalUuidEquals(candidate.surfaceId, original.surfaceId)
      ) ?? null;
    if (original.provider.source !== "provider-session-mapping") {
      if (mapping !== null) {
        throw new Error("The saved provider conversation changed while the picker was open. Refresh and try again.");
      }
      return null;
    }
    if (
      mapping === null ||
      original.provider.sessionId === null ||
      mapping.provider !== original.provider.provider ||
      !canonicalUuidEquals(mapping.providerSessionId, original.provider.sessionId)
    ) {
      throw new Error("The saved provider conversation changed while the picker was open. Refresh and try again.");
    }
    return mapping;
  }

  private resolveCurrentBindingSession(original: LiveSession): LiveSession {
    const current = this.resolveCurrentSession(original);
    const provider = original.provider.provider;
    const originalSessionId =
      provider === "claude" || provider === "codex"
        ? normalizeCanonicalUuid(original.provider.sessionId ?? "")
        : null;
    if (originalSessionId === null) return current;

    const currentSessionId = normalizeCanonicalUuid(current.provider.sessionId ?? "");
    if (current.provider.provider !== provider || currentSessionId !== originalSessionId) {
      throw new Error("The exact provider conversation changed before the task binding was updated.");
    }
    return current;
  }

  private expectedTaskBinding(
    original: LiveSession,
    current: LiveSession
  ): BindingRecord | null {
    const binding = this.bindings.findBySurface(current.surfaceId);
    if (original.linkedTaskId === null) {
      if (
        binding !== null &&
        !bindingConflictsWithExactProviderIdentity(binding, current)
      ) {
        throw new Error("The task binding changed while the picker was open. Refresh and try again.");
      }
      return binding;
    }
    if (
      binding === null ||
      !canonicalUuidEquals(binding.taskId, original.linkedTaskId) ||
      !canonicalUuidEquals(binding.workspaceId, current.workspaceId) ||
      !canonicalUuidEquals(binding.paneId, current.paneId) ||
      !canonicalUuidEquals(binding.surfaceId, current.surfaceId)
    ) {
      throw new Error("The task binding changed while the picker was open. Refresh and try again.");
    }
    return binding;
  }

  private async attachTaskInternal(session: LiveSession, task: TaskRecord): Promise<void> {
    if (this.disposed) return;
    const current = this.resolveCurrentBindingSession(session);
    const expectedBinding = this.expectedTaskBinding(session, current);
    validateBindingIdentity(task.taskId, current);
    this.requireTaskRepository().findById(task.taskId);
    const attachedAt = new Date().toISOString();
    const result = await this.bindings.attachIfSurfaceUnchanged(
      {
        taskId: task.taskId,
        workspaceId: current.workspaceId,
        paneId: current.paneId,
        surfaceId: current.surfaceId,
        provider: current.provider.provider,
        providerSessionId: current.provider.sessionId,
        attachedAt
      },
      expectedBinding
    );
    if (this.disposed) return;
    if (result === null) {
      throw new Error("The task binding changed while the picker was open. Refresh and try again.");
    }
    this.store.update({ bindings: this.bindings.list(), runs: this.bindings.listRuns() });
    if (result.isNewRun) {
      try {
        const runCount = await this.persistNewRunCount(task);
        if (this.disposed) return;
        this.store.update((state) => ({
          tasks: state.tasks.map((candidate) =>
            candidate.taskId === task.taskId ? { ...candidate, runCount, updatedAt: attachedAt } : candidate
          )
        }));
      } catch (error) {
        if (this.disposed) return;
        new Notice(`Session attached, but run count was not updated: ${readableError(error)}`);
      }
    }
    this.recomputeSessions();
  }

  private async persistNewRunCount(task: TaskRecord): Promise<number> {
    const repository = this.requireTaskRepository();
    try {
      return await repository.incrementRunCount(task);
    } catch {
      // The vault API may reject before or after applying a frontmatter edit.
      // Reconcile to a minimum instead of repeating the increment, which keeps
      // this recovery idempotent in both cases.
      const recordedRuns = this.bindings.listRuns(task.taskId).length;
      const expected = Math.min(1_000_000, Math.max(task.runCount + 1, recordedRuns));
      return repository.ensureRunCountAtLeast(task, expected);
    }
  }

  private handleError(error: unknown, connectionFailure = true): void {
    if (this.disposed || isAbort(error)) return;
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
    if (this.client === null) throw new CmuxError("cmux-not-running", `${PRODUCT_NAME} is not connected to cmux.`);
    return this.client;
  }

  private requireSettings(): AgentCockpitSettings {
    if (this.settings === null) throw new Error(`${PRODUCT_NAME} settings are not loaded.`);
    return this.settings;
  }

  private requireTaskRepository(): TaskRepository {
    if (this.taskRepository === null) throw new Error("Task repository is not initialized.");
    return this.taskRepository;
  }
}

function providerSurfaceIdentities(snapshot: CmuxSnapshot): ProviderSurfaceIdentity[] {
  return snapshot.windows.flatMap((window) =>
    window.workspaces.flatMap((workspace) =>
      workspace.panes.flatMap((pane) =>
        pane.surfaces.map((surface) => ({
          key: surfaceKey({ workspaceId: workspace.id, surfaceId: surface.id }),
          surfaceTitle: surface.title,
          surfaceType: surface.type,
          currentDirectory: workspace.currentDirectory
        }))
      )
    )
  );
}

function previewSurfaceSignature(session: LiveSession): string {
  const providerSessionId =
    (session.provider.provider === "claude" || session.provider.provider === "codex") &&
    session.provider.sessionId !== null
      ? normalizeCanonicalUuid(session.provider.sessionId)
      : null;
  return JSON.stringify([
    session.surfaceTitle,
    session.surfaceType,
    session.currentDirectory,
    providerSessionId === null ? null : session.provider.provider,
    providerSessionId
  ]);
}

function automaticRunCountError(error: unknown): Error {
  return new Error(`The automatic task run count could not be updated: ${readableError(error)}`);
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
  return error instanceof Error ? error.message : `An unknown ${PRODUCT_NAME} error occurred.`;
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
