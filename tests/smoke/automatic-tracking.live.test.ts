import type { Plugin } from "obsidian";
import { describe, expect, it } from "vitest";
import { AgentCockpitController } from "../../src/app/AgentCockpitController";
import { CmuxClient } from "../../src/cmux/CmuxClient";
import type { CmuxTransport, PreviewRequest } from "../../src/cmux/CmuxTransport";
import { CliCmuxTransport } from "../../src/cmux/CliCmuxTransport";
import type {
  CmuxAgentRecord,
  CmuxNotification,
  CmuxPreview,
  CmuxProbe,
  CmuxSnapshot,
  CmuxTarget
} from "../../src/cmux/types";
import { ProviderMetadataService } from "../../src/providers/ProviderMetadataService";
import { AutomaticProviderSessionResolver } from "../../src/providers/identity/AutomaticProviderSessionResolver";
import { isCanonicalUuid } from "../../src/security/identifiers";
import { automaticTaskId, automaticTaskTitle } from "../../src/tracking/AutomaticTaskTracking";
import { createMemoryTaskApp } from "../helpers/memoryTaskApp";

const live =
  process.env.CMUX_AGENT_ORCHESTRATOR_LIVE_TRACKING === "1" ? describe : describe.skip;
const CMUX_BINARY = "/Applications/cmux.app/Contents/Resources/bin/cmux";

class NoControlCmuxTransport implements CmuxTransport {
  focusAttempts = 0;

  constructor(private readonly delegate: CmuxTransport) {}

  probe(signal?: AbortSignal): Promise<CmuxProbe> {
    return this.delegate.probe(signal);
  }

  snapshot(signal?: AbortSignal): Promise<CmuxSnapshot> {
    return this.delegate.snapshot(signal);
  }

  notifications(signal?: AbortSignal): Promise<CmuxNotification[]> {
    return this.delegate.notifications(signal);
  }

  agents(signal?: AbortSignal): Promise<CmuxAgentRecord[] | null> {
    return this.delegate.agents?.(signal) ?? Promise.resolve(null);
  }

  readPreview(target: CmuxTarget, _request: PreviewRequest): Promise<CmuxPreview> {
    // Automatic tracking must be driven by exact structured identity, not terminal text.
    return Promise.resolve({ ...target, text: "", observedAt: Date.now(), truncated: false });
  }

  focusedTarget(_signal?: AbortSignal): Promise<CmuxTarget | null> {
    return Promise.resolve(null);
  }

  focus(_target: CmuxTarget, _signal?: AbortSignal): Promise<void> {
    this.focusAttempts += 1;
    return Promise.reject(new Error("A read-only automatic-tracking smoke attempted to focus cmux."));
  }

  dispose(): void {
    this.delegate.dispose();
  }
}

live("automatic work tracking against installed cmux", () => {
  it("reconciles exact live identities once across an in-memory controller reload", async () => {
    const { app, markdownWrites } = createMemoryTaskApp();
    let persisted: unknown = {
      schemaVersion: 3,
      settings: { autoTrackAgentRuns: true },
      machines: {}
    };
    const plugin = {
      loadData: async () => structuredClone(persisted),
      saveData: async (next: unknown) => {
        persisted = structuredClone(next);
      }
    } as unknown as Plugin;
    const createController = () => {
      const metadata = new ProviderMetadataService();
      const resolver = new AutomaticProviderSessionResolver(metadata);
      const transport = new NoControlCmuxTransport(new CliCmuxTransport(CMUX_BINARY));
      const controller = new AgentCockpitController(
        app,
        plugin,
        async () => new CmuxClient(transport),
        metadata,
        resolver
      );
      return { controller, metadata, transport };
    };

    const first = createController();
    let firstTaskIds: string[] = [];

    try {
      await first.controller.initialize();
      await first.controller.waitForBackgroundWork();

      const state = first.controller.store.getState();
      const tasks = [...state.tasks];
      const bindings = [...state.bindings];
      const runs = [...state.runs];
      firstTaskIds = tasks.map((task) => task.taskId);
      expect(state.connection.status).toBe("connected");
      expect(tasks.length).toBeGreaterThan(0);
      expect(bindings).toHaveLength(tasks.length);
      expect(runs).toHaveLength(tasks.length);
      expect(markdownWrites).toHaveLength(tasks.length);
      expect(first.transport.focusAttempts).toBe(0);

      const tasksById = new Map(tasks.map((task) => [task.taskId, task] as const));
      const sessionsBySurface = new Map(
        state.sessions.map((session) => [session.surfaceId, session] as const)
      );
      const markdown = markdownWrites.join("\n");
      for (const binding of bindings) {
        expect(binding.provider === "claude" || binding.provider === "codex").toBe(true);
        expect(binding.providerSessionId).not.toBeNull();
        expect(isCanonicalUuid(binding.providerSessionId ?? "")).toBe(true);
        const provider = binding.provider === "claude" ? "claude" : "codex";
        const task = tasksById.get(binding.taskId);
        const session = sessionsBySurface.get(binding.surfaceId);
        expect(task).toBeDefined();
        expect(session).toBeDefined();
        expect(task).toMatchObject({
          taskId: automaticTaskId(provider, binding.providerSessionId!),
          title: automaticTaskTitle(session!, provider),
          workflowStatus: "active",
          priority: "normal",
          runCount: 1
        });
        expect(markdown).not.toContain(binding.providerSessionId!);
        expect(markdown).not.toContain(binding.surfaceId);
      }

      const taskTitles = new Set(tasks.map((task) => task.title));
      for (const providerSession of first.metadata.evidence.values()) {
        if (!taskTitles.has(providerSession.title)) {
          expect(markdown).not.toContain(`title: ${JSON.stringify(providerSession.title)}`);
        }
      }
    } finally {
      first.controller.dispose();
    }

    const second = createController();
    try {
      await second.controller.initialize();
      await second.controller.waitForBackgroundWork();

      const state = second.controller.store.getState();
      expect(state.connection.status).toBe("connected");
      expect(second.transport.focusAttempts).toBe(0);
      for (const taskId of firstTaskIds) {
        expect(state.tasks.filter((task) => task.taskId === taskId)).toHaveLength(1);
        expect(state.runs.filter((run) => run.taskId === taskId)).toHaveLength(1);
        expect(
          markdownWrites.filter((markdown) => markdown.includes(`task-id: ${JSON.stringify(taskId)}`))
        ).toHaveLength(1);
      }
    } finally {
      second.controller.dispose();
    }
  }, 120_000);
});
