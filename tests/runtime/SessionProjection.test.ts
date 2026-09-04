import { describe, expect, it } from "vitest";
import { AgentDetector } from "../../src/agents/AgentDetector";
import type { CmuxSnapshot } from "../../src/cmux/types";
import { providerMetadataKey } from "../../src/providers/ProviderMetadataService";
import type { ProviderSessionMetadata } from "../../src/providers/types";
import { projectLiveSessions } from "../../src/runtime/SessionProjection";

const workspaceId = "a2222222-a222-4222-8222-a22222222222";
const paneId = "b3333333-b333-4333-8333-b33333333333";
const surfaceId = "c4444444-c444-4444-8444-c44444444444";
const providerSessionId = "d5555555-d555-4555-8555-d5555555555a";

function snapshot(): CmuxSnapshot {
  return {
    observedAt: 1_000,
    windows: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        index: 0,
        current: true,
        visible: true,
        active: true,
        selectedWorkspaceId: workspaceId,
        workspaces: [
          {
            id: workspaceId,
            index: 0,
            title: "project",
            selected: true,
            active: true,
            pinned: false,
            currentDirectory: "/workspace/project",
            panes: [
              {
                id: paneId,
                index: 0,
                focused: true,
                active: true,
                selectedSurfaceId: surfaceId,
                surfaces: [
                  {
                    id: surfaceId,
                    paneId,
                    index: 0,
                    indexInPane: 0,
                    title: "project",
                    type: "terminal",
                    selected: true,
                    focused: true,
                    active: true
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}

const metadata: ProviderSessionMetadata = {
  provider: "codex",
  sessionId: providerSessionId,
  title: "Implement exact conversation titles",
  titleSource: "explicit-name",
  cwd: "/workspace/project",
  updatedAt: 900,
  status: "idle"
};

function project(pane = paneId, providerMetadata = metadata) {
  return projectLiveSessions({
    snapshot: snapshot(),
    notifications: [],
    bindings: [],
    providerMappings: [
      {
        workspaceId,
        paneId: pane,
        surfaceId,
        provider: "codex",
        providerSessionId: providerSessionId.toUpperCase(),
        matchedAt: "2026-09-02T00:00:00.000Z"
      }
    ],
    providerMetadata: new Map([
      [providerMetadataKey("codex", providerSessionId), providerMetadata]
    ]),
    detector: new AgentDetector(),
    providerEvidence: new Map(),
    previewFor: () => null,
    evidenceFor: () => []
  })[0]!;
}

describe("projectLiveSessions provider conversations", () => {
  it("projects the title only after an exact canonical surface match", () => {
    const session = project();
    expect(session.provider).toMatchObject({
      provider: "codex",
      confidence: "high",
      source: "provider-session-mapping",
      sessionId: providerSessionId
    });
    expect(session.conversation).toMatchObject({
      title: "Implement exact conversation titles",
      matchSource: "manual",
      matchConfidence: "high"
    });
  });

  it("projects a saved mapping whose complete cmux tuple uses uppercase UUIDs", () => {
    const session = projectLiveSessions({
      snapshot: snapshot(),
      notifications: [],
      bindings: [],
      providerMappings: [
        {
          workspaceId: workspaceId.toUpperCase(),
          paneId: paneId.toUpperCase(),
          surfaceId: surfaceId.toUpperCase(),
          provider: "codex",
          providerSessionId: providerSessionId.toUpperCase(),
          matchedAt: "2026-09-02T00:00:00.000Z"
        }
      ],
      providerMetadata: new Map([
        [providerMetadataKey("codex", providerSessionId), metadata]
      ]),
      detector: new AgentDetector(),
      providerEvidence: new Map(),
      previewFor: () => null,
      evidenceFor: () => []
    })[0]!;

    expect(session.conversation?.title).toBe("Implement exact conversation titles");
  });

  it("fails closed when either the pane identity or provider CWD differs", () => {
    expect(project("66666666-6666-4666-8666-666666666666").conversation).toBeNull();
    expect(project(paneId, { ...metadata, cwd: "/workspace/other" }).conversation).toBeNull();
  });

  it("does not restore a saved provider identity on a surface rejected this refresh", () => {
    const session = projectLiveSessions({
      snapshot: snapshot(),
      notifications: [],
      bindings: [],
      providerMappings: [
        {
          workspaceId,
          paneId,
          surfaceId,
          provider: "codex",
          providerSessionId,
          matchedAt: "2026-09-02T00:00:00.000Z"
        }
      ],
      suppressedProviderSurfaceIds: new Set([surfaceId]),
      providerMetadata: new Map([
        [providerMetadataKey("codex", providerSessionId), metadata]
      ]),
      detector: new AgentDetector(),
      providerEvidence: new Map(),
      previewFor: () => null,
      evidenceFor: () => []
    })[0]!;

    expect(session.provider.sessionId).toBeNull();
    expect(session.conversation).toBeNull();
  });

  it("keeps two same-repository surfaces distinct by exact provider session ID", () => {
    const secondSurfaceId = "66666666-6666-4666-8666-666666666666";
    const secondProviderSessionId = "77777777-7777-4777-8777-777777777777";
    const current = snapshot();
    current.windows[0]!.workspaces[0]!.panes[0]!.surfaces.push({
      id: secondSurfaceId,
      paneId,
      index: 1,
      indexInPane: 1,
      title: "project",
      type: "terminal",
      selected: false,
      focused: false,
      active: false
    });
    const sessions = projectLiveSessions({
      snapshot: current,
      notifications: [],
      bindings: [],
      providerMappings: [
        {
          workspaceId,
          paneId,
          surfaceId,
          provider: "codex",
          providerSessionId,
          matchedAt: "2026-09-02T00:00:00.000Z"
        },
        {
          workspaceId,
          paneId,
          surfaceId: secondSurfaceId,
          provider: "codex",
          providerSessionId: secondProviderSessionId,
          matchedAt: "2026-09-02T00:01:00.000Z"
        }
      ],
      providerMetadata: new Map([
        [providerMetadataKey("codex", providerSessionId), metadata],
        [
          providerMetadataKey("codex", secondProviderSessionId),
          {
            ...metadata,
            sessionId: secondProviderSessionId,
            title: "Review the timeout fix"
          }
        ]
      ]),
      detector: new AgentDetector(),
      providerEvidence: new Map(),
      previewFor: () => null,
      evidenceFor: () => []
    });

    expect(sessions.map((session) => session.conversation?.title)).toEqual([
      "Implement exact conversation titles",
      "Review the timeout fix"
    ]);
  });

  it("uses an exact in-memory automatic match without persisting or weakening manual precedence", () => {
    const automatic = {
      workspaceId,
      paneId,
      surfaceId,
      provider: "codex" as const,
      providerSessionId: providerSessionId.toUpperCase(),
      matchSource: "codex-writer-lock" as const,
      confidence: "high" as const,
      explanation: "Verified foreground process and root writer lock.",
      observedAt: 1_000
    };
    const automaticSession = projectLiveSessions({
      snapshot: snapshot(),
      notifications: [],
      bindings: [],
      providerMappings: [],
      automaticProviderMappings: [automatic],
      providerMetadata: new Map([
        [providerMetadataKey("codex", providerSessionId), metadata]
      ]),
      detector: new AgentDetector(),
      providerEvidence: new Map(),
      previewFor: () => null,
      evidenceFor: () => []
    })[0]!;

    expect(automaticSession.provider).toMatchObject({
      provider: "codex",
      source: "codex-writer-lock",
      sessionId: providerSessionId
    });
    expect(automaticSession.conversation).toMatchObject({
      title: "Implement exact conversation titles",
      matchSource: "codex-writer-lock",
      matchConfidence: "high"
    });

    const manualSession = projectLiveSessions({
      snapshot: snapshot(),
      notifications: [],
      bindings: [],
      providerMappings: [
        {
          workspaceId,
          paneId,
          surfaceId,
          provider: "codex",
          providerSessionId,
          matchedAt: "2026-09-02T00:00:00.000Z"
        }
      ],
      automaticProviderMappings: [{ ...automatic, explanation: "Automatic evidence." }],
      providerMetadata: new Map([
        [providerMetadataKey("codex", providerSessionId), metadata]
      ]),
      detector: new AgentDetector(),
      providerEvidence: new Map(),
      previewFor: () => null,
      evidenceFor: () => []
    })[0]!;
    expect(manualSession.provider.source).toBe("provider-session-mapping");
    expect(manualSession.conversation?.matchSource).toBe("manual");
  });

  it("does not let an absent saved surface shadow fresh exact process evidence", () => {
    const session = projectLiveSessions({
      snapshot: snapshot(),
      notifications: [],
      bindings: [],
      providerMappings: [
        {
          workspaceId,
          paneId,
          surfaceId: "66666666-6666-4666-8666-666666666666",
          provider: "codex",
          providerSessionId,
          matchedAt: "2026-09-02T00:00:00.000Z"
        }
      ],
      automaticProviderMappings: [
        {
          workspaceId,
          paneId,
          surfaceId,
          provider: "codex",
          providerSessionId,
          matchSource: "codex-writer-lock",
          confidence: "high",
          explanation: "Verified current foreground process and root writer lock.",
          observedAt: 1_000
        }
      ],
      providerMetadata: new Map([
        [providerMetadataKey("codex", providerSessionId), metadata]
      ]),
      detector: new AgentDetector(),
      providerEvidence: new Map(),
      previewFor: () => null,
      evidenceFor: () => []
    })[0]!;

    expect(session.provider).toMatchObject({
      provider: "codex",
      source: "codex-writer-lock",
      sessionId: providerSessionId
    });
    expect(session.conversation).toMatchObject({
      title: "Implement exact conversation titles",
      matchSource: "codex-writer-lock"
    });
  });

  it("does not carry a task binding onto a different exact provider session on the same surface", () => {
    const nextProviderSessionId = "e6666666-e666-4666-8666-e6666666666b";
    const session = projectLiveSessions({
      snapshot: snapshot(),
      notifications: [],
      bindings: [
        {
          bindingId: "11111111-aaaa-4111-8111-111111111111",
          runId: "22222222-aaaa-4222-8222-222222222222",
          taskId: "33333333-aaaa-4333-8333-333333333333",
          workspaceId,
          paneId,
          surfaceId,
          provider: "codex",
          providerSessionId,
          attachedAt: "2026-09-02T00:00:00.000Z"
        }
      ],
      providerMappings: [],
      automaticProviderMappings: [
        {
          workspaceId,
          paneId,
          surfaceId,
          provider: "codex",
          providerSessionId: nextProviderSessionId,
          matchSource: "codex-writer-lock",
          confidence: "high",
          explanation: "Verified a new foreground root writer on the reused surface.",
          observedAt: 1_000
        }
      ],
      providerMetadata: new Map(),
      detector: new AgentDetector(),
      providerEvidence: new Map(),
      previewFor: () => null,
      evidenceFor: () => []
    })[0]!;

    expect(session.provider).toMatchObject({
      provider: "codex",
      source: "codex-writer-lock",
      sessionId: nextProviderSessionId
    });
    expect(session.linkedTaskId).toBeNull();
  });

  it("lets fresh exact process identity override a stale saved conversation without weakening manual precedence", () => {
    const nextProviderSessionId = "e6666666-e666-4666-8666-e6666666666b";
    const binding = {
      bindingId: "11111111-aaaa-4111-8111-111111111111",
      runId: "22222222-aaaa-4222-8222-222222222222",
      taskId: "33333333-aaaa-4333-8333-333333333333",
      workspaceId,
      paneId,
      surfaceId,
      provider: "codex" as const,
      providerSessionId,
      attachedAt: "2026-09-02T00:00:00.000Z"
    };
    const savedMapping = {
      workspaceId,
      paneId,
      surfaceId,
      provider: "codex" as const,
      providerSessionId,
      matchedAt: "2026-09-02T00:00:00.000Z"
    };
    const projectConflict = (confidence: "medium" | "high") => projectLiveSessions({
      snapshot: snapshot(),
      notifications: [],
      bindings: [binding],
      providerMappings: [savedMapping],
      automaticProviderMappings: [
        {
          workspaceId,
          paneId,
          surfaceId,
          provider: "codex",
          providerSessionId: nextProviderSessionId,
          matchSource: "codex-writer-lock",
          confidence,
          explanation: "Verified the current foreground root writer on the reused surface.",
          observedAt: 1_000
        }
      ],
      providerMetadata: new Map(),
      detector: new AgentDetector(),
      providerEvidence: new Map(),
      previewFor: () => null,
      evidenceFor: () => []
    })[0]!;

    const session = projectConflict("high");

    expect(session.provider).toMatchObject({
      provider: "codex",
      source: "codex-writer-lock",
      sessionId: nextProviderSessionId
    });
    expect(session.linkedTaskId).toBeNull();

    const weakerSession = projectConflict("medium");
    expect(weakerSession.provider).toMatchObject({
      provider: "codex",
      source: "provider-session-mapping",
      sessionId: providerSessionId
    });
    expect(weakerSession.linkedTaskId).toBe(binding.taskId);
  });

  it("does not project a task binding from a different pane onto the live surface", () => {
    const session = projectLiveSessions({
      snapshot: snapshot(),
      notifications: [],
      bindings: [
        {
          bindingId: "11111111-aaaa-4111-8111-111111111111",
          runId: "22222222-aaaa-4222-8222-222222222222",
          taskId: "33333333-aaaa-4333-8333-333333333333",
          workspaceId,
          paneId: "f7777777-f777-4777-8777-f77777777777",
          surfaceId,
          provider: "codex",
          providerSessionId,
          attachedAt: "2026-09-02T00:00:00.000Z"
        }
      ],
      providerMappings: [],
      providerMetadata: new Map(),
      detector: new AgentDetector(),
      providerEvidence: new Map(),
      previewFor: () => null,
      evidenceFor: () => []
    })[0]!;

    expect(session.linkedTaskId).toBeNull();
  });
});
