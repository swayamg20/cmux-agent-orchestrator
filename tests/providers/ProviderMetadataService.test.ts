import { describe, expect, it, vi } from "vitest";
import { ProviderMetadataService } from "../../src/providers/ProviderMetadataService";
import type {
  ProviderSessionMetadata,
  ProviderSessionSource
} from "../../src/providers/types";
import type { LiveSession } from "../../src/state/types";

const metadata: ProviderSessionMetadata = {
  provider: "codex",
  sessionId: "55555555-5555-4555-8555-55555555555a",
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

function distinctSessionId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

describe("ProviderMetadataService", () => {
  it("refreshes metadata only for a mapping that resolves to the exact live target", async () => {
    const get = vi.fn(async () => metadata);
    const list = vi.fn(async () => [
      { ...metadata, sessionId: metadata.sessionId.toUpperCase() }
    ]);
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
          providerSessionId: metadata.sessionId.toUpperCase(),
          matchedAt: "2026-09-02T00:00:00.000Z"
        }
      ],
      [liveSession()]
    );

    expect(get).toHaveBeenCalledWith(metadata.sessionId, metadata.cwd, expect.any(AbortSignal));
    expect(service.evidence.get(`codex:${metadata.sessionId}`)).toEqual(metadata);
    service.dispose();
  });

  it("refreshes an exact target when the saved cmux tuple uses different UUID casing", async () => {
    const list = vi.fn(async () => [metadata]);
    const source: ProviderSessionSource = {
      provider: "codex",
      list,
      get: vi.fn(async () => metadata),
      dispose: vi.fn()
    };
    const service = new ProviderMetadataService([source]);
    const session = {
      ...liveSession(),
      workspaceId: "a2222222-a222-4222-8222-a22222222222",
      paneId: "b3333333-b333-4333-8333-b33333333333",
      surfaceId: "c4444444-c444-4444-8444-c44444444444"
    };

    await service.refreshMapped(
      [
        {
          workspaceId: session.workspaceId.toUpperCase(),
          paneId: session.paneId.toUpperCase(),
          surfaceId: session.surfaceId.toUpperCase(),
          provider: "codex",
          providerSessionId: metadata.sessionId,
          matchedAt: "2026-09-02T00:00:00.000Z"
        }
      ],
      [session]
    );

    expect(list).toHaveBeenCalledWith(metadata.cwd, expect.any(AbortSignal));
    service.dispose();
  });

  it("rejects an exact source result for a different provider session", async () => {
    const otherSessionId = "66666666-6666-4666-8666-66666666666a";
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [],
      get: async () => ({ ...metadata, sessionId: otherSessionId }),
      dispose: vi.fn()
    };
    const service = new ProviderMetadataService([source]);

    await expect(
      service.get("codex", metadata.sessionId, metadata.cwd)
    ).resolves.toBeNull();
    expect(service.evidence.size).toBe(0);
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

  it("discards an exact metadata response when the provider ignores caller cancellation", async () => {
    let resolveGet!: (value: ProviderSessionMetadata | null) => void;
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [],
      get: async () => new Promise<ProviderSessionMetadata | null>((resolve) => {
        resolveGet = resolve;
      }),
      dispose: vi.fn()
    };
    const service = new ProviderMetadataService([source]);
    const controller = new AbortController();
    const pending = service.get("codex", metadata.sessionId, metadata.cwd, controller.signal);

    controller.abort();
    resolveGet(metadata);

    await expect(pending).resolves.toBeNull();
    expect(service.evidence.has(`codex:${metadata.sessionId}`)).toBe(false);
    service.dispose();
  });

  it("discards a metadata list when the provider ignores caller cancellation", async () => {
    let resolveList!: (value: ProviderSessionMetadata[]) => void;
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => new Promise<ProviderSessionMetadata[]>((resolve) => {
        resolveList = resolve;
      }),
      get: async () => null,
      dispose: vi.fn()
    };
    const service = new ProviderMetadataService([source]);
    const controller = new AbortController();
    const pending = service.list("codex", metadata.cwd, controller.signal);

    controller.abort();
    resolveList([metadata]);

    await expect(pending).resolves.toEqual([]);
    expect(service.evidence.has(`codex:${metadata.sessionId}`)).toBe(false);
    service.dispose();
  });

  it("does not let an older list response overwrite newer conversation metadata", async () => {
    const resolvers: Array<(value: ProviderSessionMetadata[]) => void> = [];
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => new Promise<ProviderSessionMetadata[]>((resolve) => resolvers.push(resolve)),
      get: async () => null,
      dispose: vi.fn()
    };
    const service = new ProviderMetadataService([source]);
    const older = service.list("codex", metadata.cwd);
    const newer = service.list("codex", metadata.cwd);

    resolvers[1]!([{ ...metadata, title: "New title", updatedAt: 2_000 }]);
    await newer;
    resolvers[0]!([{ ...metadata, title: "Old title", updatedAt: 1_000 }]);
    await older;

    expect(service.evidence.get(`codex:${metadata.sessionId}`)).toMatchObject({
      title: "New title",
      updatedAt: 2_000
    });
    service.dispose();
  });

  it("returns newer listed metadata to a superseded exact reader", async () => {
    let resolveGet!: (value: ProviderSessionMetadata | null) => void;
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [{ ...metadata, title: "New listed title", updatedAt: 2_000 }],
      get: async () => new Promise<ProviderSessionMetadata | null>((resolve) => {
        resolveGet = resolve;
      }),
      dispose: vi.fn()
    };
    const service = new ProviderMetadataService([source]);
    const older = service.get("codex", metadata.sessionId, metadata.cwd);

    await service.list("codex", metadata.cwd);
    resolveGet({ ...metadata, title: "Old exact title", updatedAt: 1_000 });

    await expect(older).resolves.toMatchObject({
      title: "New listed title",
      updatedAt: 2_000
    });
    expect(service.evidence.get(`codex:${metadata.sessionId}`)).toMatchObject({
      title: "New listed title",
      updatedAt: 2_000
    });
    service.dispose();
  });

  it("does not substitute newer metadata from a different working directory", async () => {
    const resolvers: Array<(value: ProviderSessionMetadata | null) => void> = [];
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [],
      get: async () => new Promise<ProviderSessionMetadata | null>((resolve) => resolvers.push(resolve)),
      dispose: vi.fn()
    };
    const service = new ProviderMetadataService([source]);
    const older = service.get("codex", metadata.sessionId, "/workspace/old");
    const newer = service.get("codex", metadata.sessionId, "/workspace/new");

    resolvers[1]!({ ...metadata, cwd: "/workspace/new", title: "Moved session" });
    await newer;
    resolvers[0]!({ ...metadata, cwd: "/workspace/old", title: "Stale location" });

    await expect(older).resolves.toBeNull();
    expect(service.evidence.get(`codex:${metadata.sessionId}`)).toMatchObject({
      cwd: "/workspace/new",
      title: "Moved session"
    });
    service.dispose();
  });

  it("forwards a superseded reader through an unresolved intermediate request", async () => {
    const resolvers: Array<(value: ProviderSessionMetadata | null) => void> = [];
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [],
      get: async () => new Promise<ProviderSessionMetadata | null>((resolve) => resolvers.push(resolve)),
      dispose: vi.fn()
    };
    const service = new ProviderMetadataService([source]);
    const first = service.get("codex", metadata.sessionId, metadata.cwd);
    const second = service.get("codex", metadata.sessionId, metadata.cwd);

    resolvers[0]!({ ...metadata, title: "First title", updatedAt: 1_000 });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    const third = service.get("codex", metadata.sessionId, metadata.cwd);
    resolvers[2]!({ ...metadata, title: "Newest title", updatedAt: 3_000 });
    await third;

    let observed: ProviderSessionMetadata | null | undefined;
    void first.then((value) => {
      observed = value;
    });
    await vi.waitFor(
      () => expect(observed).toMatchObject({ title: "Newest title", updatedAt: 3_000 }),
      { timeout: 50, interval: 1 }
    );
    resolvers[1]!({ ...metadata, title: "Intermediate title", updatedAt: 2_000 });
    await second;

    service.dispose();
  });

  it("does not let an older exact read restore metadata after a newer miss", async () => {
    const resolvers: Array<(value: ProviderSessionMetadata | null) => void> = [];
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [],
      get: async () => new Promise<ProviderSessionMetadata | null>((resolve) => resolvers.push(resolve)),
      dispose: vi.fn()
    };
    const service = new ProviderMetadataService([source]);
    const older = service.get("codex", metadata.sessionId, metadata.cwd);
    const newer = service.get("codex", metadata.sessionId, metadata.cwd);

    resolvers[1]!(null);
    await newer;
    resolvers[0]!(metadata);
    await expect(older).resolves.toBeNull();

    expect(service.evidence.has(`codex:${metadata.sessionId}`)).toBe(false);
    service.dispose();
  });

  it("keeps an explicit forget newer than an in-flight metadata read", async () => {
    let resolveGet!: (value: ProviderSessionMetadata | null) => void;
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [],
      get: async () => new Promise<ProviderSessionMetadata | null>((resolve) => {
        resolveGet = resolve;
      }),
      dispose: vi.fn()
    };
    const service = new ProviderMetadataService([source]);
    const pending = service.get("codex", metadata.sessionId, metadata.cwd);

    service.forget("codex", metadata.sessionId);
    resolveGet(metadata);
    await expect(pending).resolves.toBeNull();

    expect(service.evidence.has(`codex:${metadata.sessionId}`)).toBe(false);
    service.dispose();
  });

  it("does not evict the forget guard for an in-flight metadata read", async () => {
    let resolveOriginal!: (value: ProviderSessionMetadata | null) => void;
    let originalReads = 0;
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [],
      get: async (sessionId) => {
        if (sessionId !== metadata.sessionId) return null;
        originalReads += 1;
        return originalReads === 1
          ? new Promise<ProviderSessionMetadata | null>((resolve) => {
              resolveOriginal = resolve;
            })
          : { ...metadata, title: "Fresh title" };
      },
      dispose: vi.fn()
    };
    const service = new ProviderMetadataService([source]);
    const pending = service.get("codex", metadata.sessionId, metadata.cwd);
    await vi.waitFor(() => expect(resolveOriginal).toBeTypeOf("function"));

    service.forget("codex", metadata.sessionId);
    for (let index = 0; index < 2_000; index += 1) {
      await service.get("codex", distinctSessionId(index), metadata.cwd);
    }
    resolveOriginal(metadata);
    await pending;

    expect(service.evidence.has(`codex:${metadata.sessionId}`)).toBe(false);
    await expect(service.get("codex", metadata.sessionId, metadata.cwd)).resolves.toMatchObject({
      title: "Fresh title"
    });
    expect(service.evidence.get(`codex:${metadata.sessionId}`)).toMatchObject({
      title: "Fresh title"
    });
    expect(
      (service as unknown as { requestRevisions: Map<string, number> }).requestRevisions.size
    ).toBeLessThanOrEqual(2_000);
    service.dispose();
  });

  it("does not evict the forget guard for an in-flight metadata list", async () => {
    let resolveList!: (value: ProviderSessionMetadata[]) => void;
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => new Promise<ProviderSessionMetadata[]>((resolve) => {
        resolveList = resolve;
      }),
      get: async () => null,
      dispose: vi.fn()
    };
    const service = new ProviderMetadataService([source]);
    const pending = service.list("codex", metadata.cwd);
    await vi.waitFor(() => expect(resolveList).toBeTypeOf("function"));

    service.forget("codex", metadata.sessionId);
    for (let index = 0; index < 2_000; index += 1) {
      await service.get("codex", distinctSessionId(index), metadata.cwd);
    }
    resolveList([metadata]);
    await pending;

    expect(service.evidence.has(`codex:${metadata.sessionId}`)).toBe(false);
    expect(
      (service as unknown as { requestRevisions: Map<string, number> }).requestRevisions.size
    ).toBeLessThanOrEqual(2_000);
    service.dispose();
  });

  it("keeps disposal terminal when a late caller forgets metadata", () => {
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [],
      get: async () => null,
      dispose: vi.fn()
    };
    const service = new ProviderMetadataService([source]);

    service.dispose();
    service.forget("codex", metadata.sessionId);

    expect(service.evidence.size).toBe(0);
    expect(
      (service as unknown as { requestRevisions: Map<string, number> }).requestRevisions.size
    ).toBe(0);
  });
});
