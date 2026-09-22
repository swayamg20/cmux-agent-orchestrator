import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/settings/AgentCockpitSettings";
import { INITIAL_COCKPIT_STATE, type CockpitState, type LiveSession } from "../../src/state/types";
import {
  buildSupportDiagnostics,
  serializeSupportDiagnostics
} from "../../src/support/SupportDiagnostics";

const PRIVATE_PATH = "/Users/example/secret-project";
const PRIVATE_TITLE = "Unreleased acquisition plan";
const PRIVATE_ID = "11111111-1111-4111-8111-111111111111";
const PRIVATE_PREVIEW = "export SECRET_TOKEN=do-not-share";

function sensitiveSession(): LiveSession {
  return {
    key: PRIVATE_ID,
    workspaceId: PRIVATE_ID,
    paneId: "22222222-2222-4222-8222-222222222222",
    surfaceId: "33333333-3333-4333-8333-333333333333",
    workspaceTitle: PRIVATE_TITLE,
    workspaceIndex: 0,
    paneIndex: 0,
    surfaceIndex: 0,
    surfaceTitle: PRIVATE_TITLE,
    surfaceType: "terminal",
    currentDirectory: PRIVATE_PATH,
    provider: {
      provider: "codex",
      confidence: "high",
      source: "cmux-agent-registry",
      explanation: PRIVATE_TITLE,
      sessionId: PRIVATE_ID
    },
    assessment: {
      surfacePresence: "present",
      agentPresence: "attached",
      executionPhase: "working",
      activity: "editing",
      coverage: "structured",
      confidence: "high",
      source: "provider-lifecycle",
      explanation: PRIVATE_TITLE,
      updatedAt: 100,
      lastActivityAt: 100,
      primaryEvidenceId: PRIVATE_ID
    },
    observedAt: 100,
    notifications: [{
      id: PRIVATE_ID,
      workspaceId: PRIVATE_ID,
      surfaceId: PRIVATE_ID,
      title: PRIVATE_TITLE,
      subtitle: PRIVATE_TITLE,
      body: PRIVATE_PREVIEW,
      isRead: false
    }],
    linkedTaskId: PRIVATE_ID,
    conversation: {
      provider: "codex",
      sessionId: PRIVATE_ID,
      title: PRIVATE_TITLE,
      titleSource: "explicit-name",
      cwd: PRIVATE_PATH,
      updatedAt: 100,
      status: "active",
      matchSource: "cmux-agent-registry",
      matchConfidence: "high"
    },
    preview: {
      workspaceId: PRIVATE_ID,
      paneId: PRIVATE_ID,
      surfaceId: PRIVATE_ID,
      text: PRIVATE_PREVIEW,
      observedAt: 100,
      truncated: false
    }
  };
}

function populatedState(): CockpitState {
  return {
    ...INITIAL_COCKPIT_STATE,
    connection: {
      status: "connected",
      message: `Connected from ${PRIVATE_PATH}`,
      versionText: `cmux 0.63.1\n${PRIVATE_PATH}`,
      accessMode: "automation",
      binaryPath: `${PRIVATE_PATH}/cmux`,
      checkedAt: 100
    },
    sessions: [sensitiveSession()],
    notifications: sensitiveSession().notifications,
    tasks: [{ workflowStatus: "active", title: PRIVATE_TITLE, taskId: PRIVATE_ID }] as unknown as CockpitState["tasks"],
    bindings: [{ bindingId: PRIVATE_ID }] as unknown as CockpitState["bindings"],
    runs: [{ runId: PRIVATE_ID }] as unknown as CockpitState["runs"],
    attention: [{ key: PRIVATE_ID }] as unknown as CockpitState["attention"],
    health: {
      topology: { status: "fresh", checkedAt: 100, lastSuccessAt: 100, message: PRIVATE_PATH },
      notifications: { status: "stale", checkedAt: 100, lastSuccessAt: 50, message: PRIVATE_TITLE },
      lifecycle: { status: "unavailable", checkedAt: 100, lastSuccessAt: null, message: PRIVATE_PREVIEW }
    },
    error: `${PRIVATE_PATH}: ${PRIVATE_PREVIEW}`
  };
}

describe("support diagnostics", () => {
  it("builds a useful aggregate snapshot from an allowlist", () => {
    const diagnostics = buildSupportDiagnostics({
      state: populatedState(),
      settings: { ...DEFAULT_SETTINGS, cmuxBinaryPath: `${PRIVATE_PATH}/cmux` },
      pluginVersion: "0.6.0",
      obsidianApiVersion: "1.13.1",
      generatedAt: 0
    });

    expect(diagnostics).toMatchObject({
      product: "cmux Agent Orchestrator",
      generatedAt: "1970-01-01T00:00:00.000Z",
      versions: { plugin: "0.6.0", obsidianApi: "1.13.1", cmux: "0.63.1" },
      connection: {
        status: "connected",
        accessMode: "automation",
        customCmuxBinaryConfigured: true
      },
      sourceHealth: {
        topology: "fresh",
        notifications: "stale",
        lifecycle: "unavailable"
      },
      inventory: {
        sessions: 1,
        sessionsByProvider: { claude: 0, codex: 1, shell: 0, unknown: 0 },
        sessionsByExecutionPhase: {
          unknown: 0,
          working: 1,
          waiting: 0,
          idle: 0,
          "turn-finished": 0,
          failed: 0
        },
        tasks: 1,
        tasksByWorkflow: { backlog: 0, active: 1, review: 0, parked: 0, done: 0 },
        bindings: 1,
        runs: 1,
        attentionItems: 1
      }
    });
  });

  it("never serializes paths, identifiers, titles, previews, notification content, or raw errors", () => {
    const serialized = serializeSupportDiagnostics(buildSupportDiagnostics({
      state: populatedState(),
      settings: { ...DEFAULT_SETTINGS, cmuxBinaryPath: `${PRIVATE_PATH}/cmux` },
      pluginVersion: "0.6.0",
      obsidianApiVersion: "1.13.1",
      generatedAt: 0
    }));

    for (const forbidden of [PRIVATE_PATH, PRIVATE_TITLE, PRIVATE_ID, PRIVATE_PREVIEW]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("fails closed for unloaded settings and untrusted version or access-mode text", () => {
    const state = {
      ...INITIAL_COCKPIT_STATE,
      connection: {
        ...INITIAL_COCKPIT_STATE.connection,
        versionText: `cmux future ${PRIVATE_PATH}`,
        accessMode: PRIVATE_PATH
      }
    };
    const diagnostics = buildSupportDiagnostics({
      state,
      settings: null,
      pluginVersion: `0.6.0 ${PRIVATE_PATH}`,
      obsidianApiVersion: `1.13.1 ${PRIVATE_TITLE}`,
      generatedAt: 0
    });

    expect(diagnostics.versions).toEqual({ plugin: "unknown", obsidianApi: "unknown", cmux: null });
    expect(diagnostics.connection.accessMode).toBeNull();
    expect(diagnostics.connection.customCmuxBinaryConfigured).toBeNull();
    expect(diagnostics.settings).toEqual({
      loaded: false,
      automaticTracking: null,
      workflowAutomation: null,
      previewLines: null,
      staleWorkingThresholdMs: null
    });
  });
});
