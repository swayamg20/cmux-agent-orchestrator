import { describe, expect, it, vi } from "vitest";
import { CmuxClient } from "../../src/cmux/CmuxClient";
import type { CmuxTransport } from "../../src/cmux/CmuxTransport";
import type { CmuxAgentRecord, CmuxSnapshot } from "../../src/cmux/types";
import { ProviderMetadataService } from "../../src/providers/ProviderMetadataService";
import { AutomaticProviderSessionResolver } from "../../src/providers/identity/AutomaticProviderSessionResolver";
import type {
  ClaudeProcessSession,
  LocalProcessIdentitySource,
  ProviderProcess
} from "../../src/providers/identity/types";
import type { ProviderSessionSource } from "../../src/providers/types";

const workspaceId = "a2222222-a222-4222-8222-a22222222222";
const paneId = "b3333333-b333-4333-8333-b33333333333";
const surfaceId = "c4444444-c444-4444-8444-c44444444444";
const secondSurfaceId = "e6666666-e666-4666-8666-e66666666666";
const sessionId = "d5555555-d555-4555-8555-d5555555555a";
const secondSessionId = "f7777777-f777-4777-8777-f77777777777";
const thirdSessionId = "08888888-8888-4888-8888-888888888888";

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

function snapshotWithTwoSurfaces(): CmuxSnapshot {
  const result = snapshot();
  const pane = result.windows[0]!.workspaces[0]!.panes[0]!;
  pane.surfaces.push({
    id: secondSurfaceId,
    paneId,
    index: 1,
    indexInPane: 1,
    title: "project duplicate",
    type: "terminal",
    selected: false,
    focused: false,
    active: true
  });
  return result;
}

function processRecord(pid = 101, provider: "claude" | "codex" = "codex"): ProviderProcess {
  return {
    pid,
    parentPid: 10,
    processGroupId: pid,
    foregroundProcessGroupId: pid,
    state: "S+",
    startedAt: "Wed Sep 2 09:49:53 2026",
    executable: provider === "codex" ? "codex" : "/opt/homebrew/bin/claude",
    provider
  };
}

class FakeProcessSource implements LocalProcessIdentitySource {
  readonly readLocks = vi.fn(async (_pid: number): Promise<string[]> => [sessionId]);
  readonly readClaude = vi.fn(
    async (_process: ProviderProcess, _cwd: string): Promise<ClaudeProcessSession | null> => null
  );
  readonly readSurface = vi.fn(async (_pid: number): Promise<string | null> => surfaceId);

  private inventoryReads = 0;

  constructor(
    private readonly processes: ProviderProcess[],
    private readonly processesAfterResolution: ProviderProcess[] = processes
  ) {}

  async listForegroundProviderProcesses(): Promise<ProviderProcess[]> {
    const inventory = this.inventoryReads++ === 0 ? this.processes : this.processesAfterResolution;
    return inventory.map((candidate) => ({ ...candidate }));
  }

  readSurfaceId(pid: number): Promise<string | null> {
    return this.readSurface(pid);
  }

  readClaudeSession(
    process: ProviderProcess,
    cwd: string
  ): Promise<ClaudeProcessSession | null> {
    return this.readClaude(process, cwd);
  }

  readCodexWriterSessionIds(pid: number): Promise<string[]> {
    return this.readLocks(pid);
  }

  dispose(): void {}
}

function codexSource(): ProviderSessionSource {
  return {
    provider: "codex",
    list: async () => [],
    get: async (requestedId, cwd) =>
      requestedId === sessionId
        ? {
            provider: "codex",
            sessionId,
            title: "Fix exact provider titles",
            titleSource: "explicit-name",
            cwd,
            updatedAt: 900,
            status: "idle",
            parentSessionId: null,
            sourceKind: "cli"
          }
        : null,
    dispose: () => undefined
  };
}

function codexWriterGraphSource(
  threads: Readonly<
    Record<
      string,
      {
        parentSessionId?: string | null;
        sourceKind?: string | null;
      }
    >
  >
): ProviderSessionSource {
  return {
    provider: "codex",
    list: async () => [],
    get: async (requestedId, cwd) => {
      const thread = threads[requestedId];
      if (!thread) return null;
      return {
        provider: "codex",
        sessionId: requestedId,
        title: `Thread ${requestedId.slice(0, 8)}`,
        titleSource: "explicit-name",
        cwd,
        updatedAt: 900,
        status: "idle",
        ...(thread.parentSessionId !== undefined
          ? { parentSessionId: thread.parentSessionId }
          : {}),
        ...(thread.sourceKind !== undefined ? { sourceKind: thread.sourceKind } : {})
      };
    },
    dispose: () => undefined
  };
}

function client(agents: CmuxAgentRecord[] | null = null): CmuxClient {
  const transport: CmuxTransport = {
    probe: async () => {
      throw new Error("not used");
    },
    snapshot: async () => snapshot(),
    notifications: async () => [],
    agents: async () => agents,
    readPreview: async () => {
      throw new Error("not used");
    },
    focusedTarget: async () => null,
    focus: async () => undefined,
    dispose: () => undefined
  };
  return new CmuxClient(transport);
}

describe("AutomaticProviderSessionResolver", () => {
  it("maps one foreground Codex writer to one exact cmux surface", async () => {
    const metadata = new ProviderMetadataService([codexSource()]);
    const processes = new FakeProcessSource([processRecord()]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(result.mappings).toEqual([
      expect.objectContaining({
        workspaceId,
        paneId,
        surfaceId,
        provider: "codex",
        providerSessionId: sessionId,
        matchSource: "codex-writer-lock",
        confidence: "high"
      })
    ]);
    expect(metadata.evidence.get(`codex:${sessionId}`)?.title).toBe("Fix exact provider titles");
    expect(processes.readLocks).toHaveBeenCalledWith(101);
    resolver.dispose();
    metadata.dispose();
  });

  it("fails closed when Codex writer locks change while exact metadata is loading", async () => {
    let markMetadataStarted: (() => void) | undefined;
    const metadataStarted = new Promise<void>((resolve) => {
      markMetadataStarted = resolve;
    });
    let finishMetadataRead: (() => void) | undefined;
    const metadataRead = new Promise<void>((resolve) => {
      finishMetadataRead = resolve;
    });
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [],
      get: async (requestedId, cwd) => {
        markMetadataStarted?.();
        await metadataRead;
        return {
          provider: "codex",
          sessionId: requestedId,
          title: "Writer that was replaced",
          titleSource: "explicit-name",
          cwd,
          updatedAt: 900,
          status: "idle",
          parentSessionId: null,
          sourceKind: "cli"
        };
      },
      dispose: () => undefined
    };
    const metadata = new ProviderMetadataService([source]);
    const processes = new FakeProcessSource([processRecord()]);
    let writerIds = [sessionId];
    processes.readLocks.mockImplementation(async () => [...writerIds]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const resolving = resolver.resolve(
      snapshot(),
      client([
        {
          surfaceId,
          state: "working",
          source: "hook",
          sessionId,
          updatedAt: 1_900
        }
      ])
    );
    await metadataStarted;
    writerIds = [secondSessionId];
    finishMetadataRead?.();
    const result = await resolving;

    expect(processes.readLocks).toHaveBeenCalledTimes(2);
    expect(result.mappings).toEqual([]);
    resolver.dispose();
    metadata.dispose();
  });

  it("fails closed before metadata reads when a Codex process holds excessive writer locks", async () => {
    const get = vi.fn(async () => null);
    const metadata = new ProviderMetadataService([{
      provider: "codex",
      list: async () => [],
      get,
      dispose: () => undefined
    }]);
    const processes = new FakeProcessSource([processRecord()]);
    const writerIds = Array.from({ length: 9 }, (_, index) =>
      `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`
    );
    processes.readLocks.mockResolvedValue(writerIds);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(result.mappings).toEqual([]);
    expect(result.suppressedSurfaceIds).toEqual([surfaceId]);
    expect(result.suppressedProviderSessionKeys).toEqual(
      writerIds.map((writerId) => `codex:${writerId}`)
    );
    expect(get).not.toHaveBeenCalled();
    resolver.dispose();
    metadata.dispose();
  });

  it.each(["missing", "failed"] as const)(
    "fails closed when one of several Codex writer locks has %s metadata",
    async (failure) => {
      const source: ProviderSessionSource = {
        provider: "codex",
        list: async () => [],
        get: async (requestedId, cwd) => {
          if (requestedId === secondSessionId) {
            if (failure === "failed") throw new Error("metadata unavailable");
            return null;
          }
          return {
            provider: "codex",
            sessionId,
            title: "Root thread",
            titleSource: "explicit-name",
            cwd,
            updatedAt: 900,
            status: "idle",
            parentSessionId: null,
            sourceKind: "cli"
          };
        },
        dispose: () => undefined
      };
      const metadata = new ProviderMetadataService([source]);
      const processes = new FakeProcessSource([processRecord()]);
      processes.readLocks.mockResolvedValue([sessionId, secondSessionId]);
      const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

      const result = await resolver.resolve(snapshot(), client());

      expect(result.mappings).toEqual([]);
      expect(result.suppressedSurfaceIds).toEqual([surfaceId]);
      expect(result.suppressedProviderSessionKeys).toEqual([
        `codex:${sessionId}`,
        `codex:${secondSessionId}`
      ]);
      resolver.dispose();
      metadata.dispose();
    }
  );

  it("leaves a surface unsuppressed when Codex has no writer lock evidence", async () => {
    const metadata = new ProviderMetadataService([codexSource()]);
    const processes = new FakeProcessSource([processRecord()]);
    processes.readLocks.mockResolvedValue([]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(result.mappings).toEqual([]);
    expect(result.suppressedSurfaceIds).toEqual([]);
    expect(result.suppressedProviderSessionKeys).toEqual([]);
    resolver.dispose();
    metadata.dispose();
  });

  it("rejects duplicate canonical Codex writer identities as ambiguous evidence", async () => {
    const metadata = new ProviderMetadataService([codexSource()]);
    const processes = new FakeProcessSource([processRecord()]);
    processes.readLocks.mockResolvedValue([sessionId, sessionId.toUpperCase()]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(result.mappings).toEqual([]);
    expect(result.suppressedSurfaceIds).toEqual([surfaceId]);
    expect(result.suppressedProviderSessionKeys).toEqual([`codex:${sessionId}`]);
    resolver.dispose();
    metadata.dispose();
  });

  it("accepts one proven root Codex lock when every competing lock is a proven subagent", async () => {
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [],
      get: async (requestedId, cwd) => ({
        provider: "codex",
        sessionId: requestedId,
        title: requestedId === sessionId ? "Root thread" : "Subagent thread",
        titleSource: "explicit-name",
        cwd,
        updatedAt: 900,
        status: "idle",
        parentSessionId: requestedId === sessionId ? null : sessionId,
        sourceKind: requestedId === sessionId ? "cli" : "subAgent"
      }),
      dispose: () => undefined
    };
    const metadata = new ProviderMetadataService([source]);
    const processes = new FakeProcessSource([processRecord()]);
    processes.readLocks.mockResolvedValue([sessionId, secondSessionId]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(result.mappings).toEqual([
      expect.objectContaining({ providerSessionId: sessionId, confidence: "high" })
    ]);
    resolver.dispose();
    metadata.dispose();
  });

  it("fails closed when a Codex subagent lock points outside the accounted writer set", async () => {
    const metadata = new ProviderMetadataService([
      codexWriterGraphSource({
        [sessionId]: { parentSessionId: null, sourceKind: "cli" },
        [secondSessionId]: { parentSessionId: thirdSessionId, sourceKind: "subAgent" }
      })
    ]);
    const processes = new FakeProcessSource([processRecord()]);
    processes.readLocks.mockResolvedValue([sessionId, secondSessionId]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(result.mappings).toEqual([]);
    resolver.dispose();
    metadata.dispose();
  });

  it("rejects multiple independent Codex roots as ambiguous identity evidence", async () => {
    const metadata = new ProviderMetadataService([
      codexWriterGraphSource({
        [sessionId]: { parentSessionId: null, sourceKind: "cli" },
        [secondSessionId]: { parentSessionId: null, sourceKind: "cli" }
      })
    ]);
    const processes = new FakeProcessSource([processRecord()]);
    processes.readLocks.mockResolvedValue([sessionId, secondSessionId]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(result.mappings).toEqual([]);
    expect(result.suppressedSurfaceIds).toEqual([surfaceId]);
    expect(result.suppressedProviderSessionKeys).toEqual([
      `codex:${sessionId}`,
      `codex:${secondSessionId}`
    ]);
    resolver.dispose();
    metadata.dispose();
  });

  it("fails closed when a Codex subagent lock omits its parent identity", async () => {
    const metadata = new ProviderMetadataService([
      codexWriterGraphSource({
        [sessionId]: { parentSessionId: null, sourceKind: "cli" },
        [secondSessionId]: { sourceKind: "subAgent" }
      })
    ]);
    const processes = new FakeProcessSource([processRecord()]);
    processes.readLocks.mockResolvedValue([sessionId, secondSessionId]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(result.mappings).toEqual([]);
    resolver.dispose();
    metadata.dispose();
  });

  it("accepts nested Codex subagent ancestry that reaches the single writer root", async () => {
    const metadata = new ProviderMetadataService([
      codexWriterGraphSource({
        [sessionId]: { parentSessionId: null, sourceKind: "cli" },
        [secondSessionId]: { parentSessionId: sessionId, sourceKind: "subAgent" },
        [thirdSessionId]: { parentSessionId: secondSessionId, sourceKind: "subAgent" }
      })
    ]);
    const processes = new FakeProcessSource([processRecord()]);
    processes.readLocks.mockResolvedValue([sessionId, secondSessionId, thirdSessionId]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(result.mappings).toEqual([
      expect.objectContaining({ providerSessionId: sessionId, confidence: "high" })
    ]);
    resolver.dispose();
    metadata.dispose();
  });

  it("fails closed when Codex subagent ancestry cycles away from the writer root", async () => {
    const metadata = new ProviderMetadataService([
      codexWriterGraphSource({
        [sessionId]: { parentSessionId: null, sourceKind: "cli" },
        [secondSessionId]: { parentSessionId: thirdSessionId, sourceKind: "subAgent" },
        [thirdSessionId]: { parentSessionId: secondSessionId, sourceKind: "subAgent" }
      })
    ]);
    const processes = new FakeProcessSource([processRecord()]);
    processes.readLocks.mockResolvedValue([sessionId, secondSessionId, thirdSessionId]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(result.mappings).toEqual([]);
    resolver.dispose();
    metadata.dispose();
  });

  it("fails closed when Codex returns metadata for a different writer-lock ID", async () => {
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [],
      get: async (_requestedId, cwd) => ({
        provider: "codex",
        sessionId: secondSessionId,
        title: "Different thread",
        titleSource: "explicit-name",
        cwd,
        updatedAt: 900,
        status: "idle",
        parentSessionId: null,
        sourceKind: "cli"
      }),
      dispose: () => undefined
    };
    const metadata = new ProviderMetadataService([source]);
    const processes = new FakeProcessSource([processRecord()]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(result.mappings).toEqual([]);
    resolver.dispose();
    metadata.dispose();
  });

  it("fails closed when Codex writer-lock metadata cannot be classified", async () => {
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async () => [],
      get: async (requestedId, cwd) => ({
        provider: "codex",
        sessionId: requestedId,
        title: "Unclassified thread",
        titleSource: "explicit-name",
        cwd,
        updatedAt: 900,
        status: "idle",
        sourceKind: "cli"
      }),
      dispose: () => undefined
    };
    const metadata = new ProviderMetadataService([source]);
    const processes = new FakeProcessSource([processRecord()]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(result.mappings).toEqual([]);
    resolver.dispose();
    metadata.dispose();
  });

  it("joins the uppercase macOS CMUX_SURFACE_ID to a lowercase cmux snapshot", async () => {
    const metadata = new ProviderMetadataService([codexSource()]);
    const processes = new FakeProcessSource([processRecord()]);
    processes.readSurface.mockResolvedValue(surfaceId.toUpperCase());
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(result.mappings).toEqual([
      expect.objectContaining({
        workspaceId,
        paneId,
        surfaceId,
        providerSessionId: sessionId
      })
    ]);
    resolver.dispose();
    metadata.dispose();
  });

  it("fails closed when two foreground providers claim the same surface", async () => {
    const metadata = new ProviderMetadataService([codexSource()]);
    const processes = new FakeProcessSource([processRecord(101), processRecord(102)]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(result.mappings).toEqual([]);
    expect(result.suppressedSurfaceIds).toEqual([surfaceId]);
    expect(processes.readLocks).not.toHaveBeenCalled();
    resolver.dispose();
    metadata.dispose();
  });

  it("fails closed when one provider conversation is claimed by two cmux surfaces", async () => {
    const metadata = new ProviderMetadataService([codexSource()]);
    const processes = new FakeProcessSource([processRecord(101), processRecord(102)]);
    processes.readSurface.mockImplementation(async (pid) =>
      pid === 101 ? surfaceId : secondSurfaceId
    );
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshotWithTwoSurfaces(), client());

    expect(result.mappings).toEqual([]);
    expect(result.issues).toContain(
      "Conflicting provider conversation identities were discarded for safety."
    );
    expect(result.suppressedSurfaceIds).toEqual([surfaceId, secondSurfaceId]);
    expect(processes.readLocks).toHaveBeenCalledTimes(4);
    resolver.dispose();
    metadata.dispose();
  });

  it("does not hide a cross-surface native conflict behind an earlier process rejection", async () => {
    const metadata = new ProviderMetadataService([codexSource()]);
    const processes = new FakeProcessSource([processRecord(101), processRecord(102)]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");
    const agents: CmuxAgentRecord[] = [
      {
        surfaceId,
        state: "working",
        source: "hook",
        sessionId,
        updatedAt: 1_900
      },
      {
        surfaceId: secondSurfaceId,
        state: "working",
        source: "hook",
        sessionId,
        updatedAt: 1_900
      }
    ];

    const result = await resolver.resolve(snapshotWithTwoSurfaces(), client(agents));

    expect(result.mappings).toEqual([]);
    expect(result.suppressedSurfaceIds).toEqual([surfaceId, secondSurfaceId]);
    expect(processes.readLocks).not.toHaveBeenCalled();
    resolver.dispose();
    metadata.dispose();
  });

  it("does not publish a native identity hidden by a process mapping that later fails revalidation", async () => {
    const metadata = new ProviderMetadataService([
      codexWriterGraphSource({
        [sessionId]: { parentSessionId: null, sourceKind: "cli" },
        [secondSessionId]: { parentSessionId: null, sourceKind: "cli" }
      })
    ]);
    const processes = new FakeProcessSource([processRecord()]);
    processes.readLocks
      .mockResolvedValueOnce([sessionId])
      .mockResolvedValueOnce([secondSessionId]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");
    const agents: CmuxAgentRecord[] = [
      {
        surfaceId,
        state: "working",
        source: "hook",
        sessionId: secondSessionId,
        updatedAt: 1_900
      },
      {
        surfaceId: secondSurfaceId,
        state: "working",
        source: "hook",
        sessionId: secondSessionId,
        updatedAt: 1_900
      }
    ];

    const result = await resolver.resolve(snapshotWithTwoSurfaces(), client(agents));

    expect(processes.readLocks).toHaveBeenCalledTimes(2);
    expect(result.mappings).toEqual([]);
    expect(result.suppressedSurfaceIds).toEqual([surfaceId, secondSurfaceId]);
    expect(result.suppressedProviderSessionKeys).toEqual([
      `codex:${sessionId}`,
      `codex:${secondSessionId}`
    ]);
    resolver.dispose();
    metadata.dispose();
  });

  it("rejects a native mapping that conflicts with a replacement identity observed during final revalidation", async () => {
    const metadata = new ProviderMetadataService([
      codexWriterGraphSource({
        [sessionId]: { parentSessionId: null, sourceKind: "cli" },
        [secondSessionId]: { parentSessionId: null, sourceKind: "cli" }
      })
    ]);
    const processes = new FakeProcessSource([processRecord()]);
    processes.readLocks
      .mockResolvedValueOnce([sessionId])
      .mockResolvedValueOnce([secondSessionId]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");
    const agents: CmuxAgentRecord[] = [
      {
        surfaceId: secondSurfaceId,
        state: "working",
        source: "hook",
        sessionId: secondSessionId,
        updatedAt: 1_900
      }
    ];

    const result = await resolver.resolve(snapshotWithTwoSurfaces(), client(agents));

    expect(result.mappings).toEqual([]);
    expect(result.suppressedSurfaceIds).toEqual([surfaceId, secondSurfaceId]);
    expect(result.suppressedProviderSessionKeys).toEqual([
      `codex:${sessionId}`,
      `codex:${secondSessionId}`
    ]);
    resolver.dispose();
    metadata.dispose();
  });

  it("discards a tentative mapping when the provider process changes during resolution", async () => {
    const metadata = new ProviderMetadataService([codexSource()]);
    const before = processRecord();
    const after = { ...before, startedAt: "Wed Sep 2 09:50:01 2026" };
    const processes = new FakeProcessSource([before], [after]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(processes.readLocks).toHaveBeenCalledWith(101);
    expect(result.mappings).toEqual([]);
    expect(result.suppressedSurfaceIds).toEqual([surfaceId]);
    resolver.dispose();
    metadata.dispose();
  });

  it("discards a Codex mapping when writer locks change during process stabilization", async () => {
    let markInventoryStarted: (() => void) | undefined;
    const inventoryStarted = new Promise<void>((resolve) => {
      markInventoryStarted = resolve;
    });
    let finishInventoryRead: (() => void) | undefined;
    const inventoryRead = new Promise<void>((resolve) => {
      finishInventoryRead = resolve;
    });
    const metadata = new ProviderMetadataService([codexSource()]);
    const process = processRecord();
    const processes = new FakeProcessSource([process]);
    let inventoryReads = 0;
    vi.spyOn(processes, "listForegroundProviderProcesses").mockImplementation(async () => {
      if (inventoryReads++ === 0) return [{ ...process }];
      markInventoryStarted?.();
      await inventoryRead;
      return [{ ...process }];
    });
    let writerIds = [sessionId];
    processes.readLocks.mockImplementation(async () => [...writerIds]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const resolving = resolver.resolve(snapshot(), client());
    await inventoryStarted;
    writerIds = [secondSessionId];
    finishInventoryRead?.();
    const result = await resolving;

    expect(processes.readLocks).toHaveBeenCalledTimes(2);
    expect(result.mappings).toEqual([]);
    expect(result.suppressedSurfaceIds).toEqual([surfaceId]);
    expect(result.suppressedProviderSessionKeys).toEqual([
      `codex:${sessionId}`,
      `codex:${secondSessionId}`
    ]);
    resolver.dispose();
    metadata.dispose();
  });

  it("suppresses every bounded Codex identity when final writer locks overflow", async () => {
    const metadata = new ProviderMetadataService([codexSource()]);
    const process = processRecord();
    const processes = new FakeProcessSource([process]);
    const finalWriterIds = [
      ...Array.from({ length: 8 }, (_, index) =>
        `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`
      ),
      secondSessionId
    ];
    processes.readLocks
      .mockResolvedValueOnce([sessionId])
      .mockResolvedValueOnce(finalWriterIds);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(processes.readLocks).toHaveBeenCalledTimes(2);
    expect(result.mappings).toEqual([]);
    expect(result.suppressedSurfaceIds).toEqual([surfaceId]);
    expect(result.suppressedProviderSessionKeys).toEqual(
      [sessionId, ...finalWriterIds]
        .map((writerId) => `codex:${writerId}`)
        .sort()
    );
    resolver.dispose();
    metadata.dispose();
  });

  it("maps a PID-bound Claude registry entry and carries its idle lifecycle separately", async () => {
    const metadata = new ProviderMetadataService([]);
    const processes = new FakeProcessSource([processRecord(202, "claude")]);
    processes.readClaude.mockResolvedValue({
      sessionId: sessionId.toUpperCase(),
      cwd: "/workspace/project",
      status: "idle"
    });
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(result.mappings[0]).toMatchObject({
      provider: "claude",
      providerSessionId: sessionId,
      matchSource: "claude-process-registry"
    });
    expect(result.lifecycle[0]).toMatchObject({
      state: "idle",
      source: "claude-registry",
      provider: "claude"
    });
    resolver.dispose();
    metadata.dispose();
  });

  it("fails closed when a stable Claude process changes registry sessions before publication", async () => {
    let markInventoryStarted: (() => void) | undefined;
    const inventoryStarted = new Promise<void>((resolve) => {
      markInventoryStarted = resolve;
    });
    let finishInventoryRead: (() => void) | undefined;
    const inventoryRead = new Promise<void>((resolve) => {
      finishInventoryRead = resolve;
    });
    const metadata = new ProviderMetadataService([]);
    const process = processRecord(202, "claude");
    const processes = new FakeProcessSource([process]);
    let inventoryReads = 0;
    vi.spyOn(processes, "listForegroundProviderProcesses").mockImplementation(async () => {
      if (inventoryReads++ === 0) return [{ ...process }];
      markInventoryStarted?.();
      await inventoryRead;
      return [{ ...process }];
    });
    let currentClaudeSession: ClaudeProcessSession = {
      sessionId,
      cwd: "/workspace/project",
      status: "idle"
    };
    processes.readClaude.mockImplementation(async () => ({ ...currentClaudeSession }));
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const resolving = resolver.resolve(
      snapshot(),
      client([
        {
          surfaceId,
          state: "working",
          source: "hook",
          sessionId,
          updatedAt: 1_900
        }
      ])
    );
    await inventoryStarted;
    currentClaudeSession = {
      sessionId: secondSessionId,
      cwd: "/workspace/project",
      status: "idle"
    };
    finishInventoryRead?.();
    const result = await resolving;

    expect(processes.readClaude).toHaveBeenCalledTimes(2);
    expect(result.mappings).toEqual([]);
    expect(result.suppressedSurfaceIds).toEqual([surfaceId]);
    expect(result.suppressedProviderSessionKeys).toEqual([
      `claude:${sessionId}`,
      `claude:${secondSessionId}`
    ]);
    expect(result.lifecycle).toEqual([
      expect.objectContaining({ provider: "unknown", providerSessionId: null })
    ]);
    resolver.dispose();
    metadata.dispose();
  });

  it("fails closed when a Claude process exits during the final registry read", async () => {
    let markFinalRegistryReadStarted: (() => void) | undefined;
    const finalRegistryReadStarted = new Promise<void>((resolve) => {
      markFinalRegistryReadStarted = resolve;
    });
    let finishFinalRegistryRead: (() => void) | undefined;
    const finalRegistryRead = new Promise<void>((resolve) => {
      finishFinalRegistryRead = resolve;
    });
    const metadata = new ProviderMetadataService([]);
    const process = processRecord(202, "claude");
    const processes = new FakeProcessSource([process]);
    let inventoryReads = 0;
    let processPresent = true;
    vi.spyOn(processes, "listForegroundProviderProcesses").mockImplementation(async () => {
      inventoryReads += 1;
      return processPresent ? [{ ...process }] : [];
    });
    let registryReads = 0;
    processes.readClaude.mockImplementation(async () => {
      registryReads += 1;
      if (registryReads === 2) {
        markFinalRegistryReadStarted?.();
        await finalRegistryRead;
      }
      if (!processPresent) return null;
      return { sessionId, cwd: "/workspace/project", status: "idle" };
    });
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const resolving = resolver.resolve(
      snapshot(),
      client([
        {
          surfaceId,
          state: "working",
          source: "hook",
          sessionId,
          updatedAt: 1_900
        }
      ])
    );
    await finalRegistryReadStarted;
    processPresent = false;
    finishFinalRegistryRead?.();
    const result = await resolving;

    expect(processes.readClaude).toHaveBeenCalledTimes(2);
    expect(inventoryReads).toBe(3);
    expect(result.mappings).toEqual([]);
    expect(result.suppressedSurfaceIds).toEqual([surfaceId]);
    expect(result.lifecycle).toEqual([
      expect.objectContaining({ provider: "unknown", providerSessionId: null })
    ]);
    resolver.dispose();
    metadata.dispose();
  });

  it("fails closed when Claude changes sessions during final process revalidation", async () => {
    let markFinalInventoryStarted: (() => void) | undefined;
    const finalInventoryStarted = new Promise<void>((resolve) => {
      markFinalInventoryStarted = resolve;
    });
    let finishFinalInventory: (() => void) | undefined;
    const finalInventory = new Promise<void>((resolve) => {
      finishFinalInventory = resolve;
    });
    const metadata = new ProviderMetadataService([]);
    const process = processRecord(202, "claude");
    const processes = new FakeProcessSource([process]);
    let inventoryReads = 0;
    vi.spyOn(processes, "listForegroundProviderProcesses").mockImplementation(async () => {
      inventoryReads += 1;
      if (inventoryReads === 3) {
        markFinalInventoryStarted?.();
        await finalInventory;
      }
      return [{ ...process }];
    });
    let currentClaudeSession: ClaudeProcessSession = {
      sessionId,
      cwd: "/workspace/project",
      status: "idle"
    };
    processes.readClaude.mockImplementation(async () => ({ ...currentClaudeSession }));
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const resolving = resolver.resolve(
      snapshot(),
      client([
        {
          surfaceId,
          state: "working",
          source: "hook",
          sessionId,
          updatedAt: 1_900
        }
      ])
    );
    await finalInventoryStarted;
    currentClaudeSession = {
      sessionId: secondSessionId,
      cwd: "/workspace/project",
      status: "idle"
    };
    finishFinalInventory?.();
    const result = await resolving;

    expect(inventoryReads).toBe(3);
    expect(processes.readClaude).toHaveBeenCalledTimes(2);
    expect(result.mappings).toEqual([]);
    expect(result.suppressedSurfaceIds).toEqual([surfaceId]);
    expect(result.lifecycle).toEqual([
      expect.objectContaining({ provider: "unknown", providerSessionId: null })
    ]);
    resolver.dispose();
    metadata.dispose();
  });

  it("prefers a modern cmux session mapping and exposes structured working state", async () => {
    const metadata = new ProviderMetadataService([codexSource()]);
    const processes = new FakeProcessSource([]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");
    const agents: CmuxAgentRecord[] = [
      {
        surfaceId,
        state: "working",
        source: "hook",
        sessionId: sessionId.toUpperCase(),
        updatedAt: 1_900
      }
    ];

    const result = await resolver.resolve(snapshot(), client(agents));

    expect(result.nativeLifecycleAvailable).toBe(true);
    expect(result.mappings[0]).toMatchObject({
      provider: "codex",
      providerSessionId: sessionId,
      matchSource: "cmux-agent-registry",
      confidence: "high"
    });
    expect(result.lifecycle[0]).toMatchObject({
      state: "working",
      source: "hook",
      occurredAt: 1_900
    });
    resolver.dispose();
    metadata.dispose();
  });

  it("does not let bounded browse metadata prove a native provider identity", async () => {
    let markExactLookupStarted: (() => void) | undefined;
    const exactLookupStarted = new Promise<void>((resolve) => {
      markExactLookupStarted = resolve;
    });
    let finishExactLookup: ((value: null) => void) | undefined;
    const exactLookup = new Promise<null>((resolve) => {
      finishExactLookup = resolve;
    });
    const source: ProviderSessionSource = {
      provider: "codex",
      list: async (cwd) => [
        {
          provider: "codex",
          sessionId,
          title: "Stale bounded browse result",
          titleSource: "explicit-name",
          cwd,
          updatedAt: 800,
          status: "idle",
          parentSessionId: null,
          sourceKind: "cli"
        }
      ],
      get: async () => {
        markExactLookupStarted?.();
        return exactLookup;
      },
      dispose: () => undefined
    };
    const metadata = new ProviderMetadataService([source]);
    const processes = new FakeProcessSource([]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");
    const agents: CmuxAgentRecord[] = [
      {
        surfaceId,
        state: "working",
        source: "hook",
        sessionId,
        updatedAt: 1_900
      }
    ];

    const resolving = resolver.resolve(snapshot(), client(agents));
    await exactLookupStarted;
    await metadata.list("codex", "/workspace/project");
    finishExactLookup?.(null);
    const result = await resolving;

    expect(result.mappings).toEqual([]);
    resolver.dispose();
    metadata.dispose();
  });

  it("keeps stronger local identity proof when detected cmux evidence agrees", async () => {
    const metadata = new ProviderMetadataService([codexSource()]);
    const processes = new FakeProcessSource([processRecord()]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");
    const agents: CmuxAgentRecord[] = [
      {
        surfaceId,
        state: "working",
        source: "detected",
        sessionId,
        updatedAt: 1_900
      }
    ];

    const result = await resolver.resolve(snapshot(), client(agents));

    expect(result.mappings).toEqual([
      expect.objectContaining({
        provider: "codex",
        providerSessionId: sessionId,
        matchSource: "codex-writer-lock",
        confidence: "high"
      })
    ]);
    expect(result.lifecycle).toEqual([
      expect.objectContaining({
        state: "working",
        source: "detected",
        provider: "codex",
        providerSessionId: sessionId
      })
    ]);
    resolver.dispose();
    metadata.dispose();
  });

  it("does not attribute conflicting native lifecycle state to the locally proven conversation", async () => {
    const metadata = new ProviderMetadataService([codexSource()]);
    const processes = new FakeProcessSource([processRecord()]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");
    const conflictingSessionId = "f7777777-f777-4777-8777-f77777777777";
    const agents: CmuxAgentRecord[] = [
      {
        surfaceId,
        state: "blocked",
        source: "hook",
        sessionId: conflictingSessionId,
        updatedAt: 1_900
      }
    ];

    const result = await resolver.resolve(snapshot(), client(agents));

    expect(result.mappings).toEqual([
      expect.objectContaining({
        provider: "codex",
        providerSessionId: sessionId,
        matchSource: "codex-writer-lock"
      })
    ]);
    expect(result.lifecycle).toEqual([]);
    expect(result.issues).toContain(
      "Conflicting cmux lifecycle identity was discarded for safety."
    );
    resolver.dispose();
    metadata.dispose();
  });
});
