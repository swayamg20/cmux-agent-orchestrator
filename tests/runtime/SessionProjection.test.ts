import { describe, expect, it } from "vitest";
import { AgentDetector } from "../../src/agents/AgentDetector";
import type { CmuxSnapshot } from "../../src/cmux/types";
import { providerMetadataKey } from "../../src/providers/ProviderMetadataService";
import type { ProviderSessionMetadata } from "../../src/providers/types";
import { projectLiveSessions } from "../../src/runtime/SessionProjection";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const paneId = "33333333-3333-4333-8333-333333333333";
const surfaceId = "44444444-4444-4444-8444-444444444444";
const providerSessionId = "55555555-5555-4555-8555-55555555555a";

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

  it("fails closed when either the pane identity or provider CWD differs", () => {
    expect(project("66666666-6666-4666-8666-666666666666").conversation).toBeNull();
    expect(project(paneId, { ...metadata, cwd: "/workspace/other" }).conversation).toBeNull();
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
});
