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

const workspaceId = "22222222-2222-4222-8222-222222222222";
const paneId = "33333333-3333-4333-8333-333333333333";
const surfaceId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-55555555555a";

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

  it("fails closed when two foreground providers claim the same surface", async () => {
    const metadata = new ProviderMetadataService([codexSource()]);
    const processes = new FakeProcessSource([processRecord(101), processRecord(102)]);
    const resolver = new AutomaticProviderSessionResolver(metadata, processes, () => 2_000, "darwin");

    const result = await resolver.resolve(snapshot(), client());

    expect(result.mappings).toEqual([]);
    expect(processes.readLocks).not.toHaveBeenCalled();
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
});
