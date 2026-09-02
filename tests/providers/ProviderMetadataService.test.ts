import { describe, expect, it, vi } from "vitest";
import { ProviderMetadataService } from "../../src/providers/ProviderMetadataService";
import type {
  ProviderSessionMetadata,
  ProviderSessionSource
} from "../../src/providers/types";
import type { LiveSession } from "../../src/state/types";

const metadata: ProviderSessionMetadata = {
  provider: "codex",
  sessionId: "55555555-5555-4555-8555-555555555555",
  title: "Exact mapped conversation",
  titleSource: "explicit-name",
  cwd: "/workspace/project",
  updatedAt: 1_000,
  status: "idle"
};

function liveSession(): LiveSession {
  return {
    key: "workspace:surface",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    paneId: "33333333-3333-4333-8333-333333333333",
    surfaceId: "44444444-4444-4444-8444-444444444444",
    workspaceTitle: "project",
    workspaceIndex: 0,
    paneIndex: 0,
    surfaceIndex: 0,
    surfaceTitle: "project",
    surfaceType: "terminal",
    currentDirectory: "/workspace/project",
    provider: {
      provider: "codex",
      confidence: "medium",
      source: "screen-preview",
      explanation: "fixture",
      sessionId: null
    },
    assessment: {
      surfacePresence: "present",
      agentPresence: "unknown",
      executionPhase: "unknown",
      activity: "unknown",
      coverage: "fallback",
      confidence: "low",
      source: "cmux-topology",
      explanation: "fixture",
      updatedAt: 1_000,
      lastActivityAt: null,
      primaryEvidenceId: null
    },
    observedAt: 1_000,
    notifications: [],
    linkedTaskId: null,
    conversation: null,
    preview: null
  };
}

describe("ProviderMetadataService", () => {
  it("refreshes metadata only for a mapping that resolves to the exact live target", async () => {
    const get = vi.fn(async () => metadata);
    const list = vi.fn(async () => [metadata]);
    const source: ProviderSessionSource = {
      provider: "codex",
      list,
      get,
      dispose: vi.fn()
    };
    const service = new ProviderMetadataService([source]);
    const mapping = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      paneId: "33333333-3333-4333-8333-333333333333",
      surfaceId: "44444444-4444-4444-8444-444444444444",
      provider: "codex" as const,
      providerSessionId: metadata.sessionId,
      matchedAt: "2026-09-02T00:00:00.000Z"
    };
    await service.refreshMapped([{ ...mapping, paneId: "66666666-6666-4666-8666-666666666666" }], [liveSession()]);
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();

    await service.refreshMapped([mapping], [liveSession()]);
    expect(list).toHaveBeenCalledWith(metadata.cwd, expect.any(AbortSignal));
    expect(get).not.toHaveBeenCalled();
    expect(service.evidence.get(`codex:${metadata.sessionId}`)).toEqual(metadata);
    service.dispose();
  });

  it("falls back to an exact metadata read when repository listing fails", async () => {
    const get = vi.fn(async () => metadata);
    const source: ProviderSessionSource = {
      provider: "codex",
      list: vi.fn(async () => {
        throw new Error("thread/list unavailable");
      }),
      get,
      dispose: vi.fn()
    };
    const service = new ProviderMetadataService([source]);

    await service.refreshMapped(
      [
        {
          workspaceId: "22222222-2222-4222-8222-222222222222",
          paneId: "33333333-3333-4333-8333-333333333333",
          surfaceId: "44444444-4444-4444-8444-444444444444",
          provider: "codex",
          providerSessionId: metadata.sessionId,
          matchedAt: "2026-09-02T00:00:00.000Z"
        }
      ],
      [liveSession()]
    );

    expect(get).toHaveBeenCalledWith(metadata.sessionId, metadata.cwd, expect.any(AbortSignal));
    expect(service.evidence.get(`codex:${metadata.sessionId}`)).toEqual(metadata);
    service.dispose();
  });

  it("propagates caller cancellation into an active provider metadata request", async () => {
    let providerSignal: AbortSignal | undefined;
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [],
      get: async (_sessionId, _cwd, signal) => {
        providerSignal = signal;
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(null), { once: true });
        });
      },
      dispose: vi.fn()
    };
    const service = new ProviderMetadataService([source]);
    const controller = new AbortController();
    const pending = service.get("codex", metadata.sessionId, metadata.cwd, controller.signal);

    controller.abort();

    await expect(pending).resolves.toBeNull();
    expect(providerSignal?.aborted).toBe(true);
    service.dispose();
  });
});
