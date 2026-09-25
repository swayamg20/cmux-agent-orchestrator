import { describe, expect, it } from "vitest";
import type { AttentionItem, LiveSession } from "../../src/state/types";
import type { TaskRecord } from "../../src/tasks/TaskSchema";
import {
  cleanSurfaceTitle,
  describeLiveRun,
  lastActiveAt,
  selectMissionControl
} from "../../src/views/MissionControlModel";

function task(
  taskId: string,
  title: string,
  workflowStatus: TaskRecord["workflowStatus"],
  repository: string | null = null,
  updatedAt = "2026-09-24T00:00:00.000Z"
): TaskRecord {
  return { taskId, title, workflowStatus, repository, updatedAt } as TaskRecord;
}

function session(
  key: string,
  taskId: string | null,
  lastActivityAt: number,
  surfacePresence: "present" | "missing" = "present"
): LiveSession {
  return {
    key,
    linkedTaskId: taskId,
    currentDirectory: "/repos/fallback",
    surfaceTitle: "",
    conversation: null,
    observedAt: 0,
    assessment: { surfacePresence, lastActivityAt }
  } as LiveSession;
}

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("MissionControlModel", () => {
  it("groups live runs by repository with the most recent activity first", () => {
    const mission = selectMissionControl({
      tasks: [
        task(A, "Older store run", "active", "/repos/store"),
        task(B, "Newer store run", "active", "/repos/store"),
        task(C, "Agent run", "active", "/repos/agent")
      ],
      sessions: [session("s1", A, 100), session("s2", B, 200), session("s3", C, 50)],
      attention: []
    });

    expect(mission.liveGroups.map((group) => group.repository)).toEqual(["store", "agent"]);
    expect(mission.liveGroups[0]!.rows.map((row) => row.task.title)).toEqual([
      "Newer store run",
      "Older store run"
    ]);
    expect(mission.stats.live).toBe(3);
  });

  it("archives active and done tasks whose cmux sessions are all closed", () => {
    const mission = selectMissionControl({
      tasks: [
        task(A, "Closed active", "active", null, "2026-09-20T00:00:00.000Z"),
        task(B, "Closed done", "done", null, "2026-09-22T00:00:00.000Z"),
        task(C, "Closed review", "review"),
        task(D, "Parked", "parked"),
        task(E, "Planned", "backlog")
      ],
      sessions: [session("s1", A, 100, "missing")],
      attention: []
    });

    expect(mission.archived.map((entry) => entry.title)).toEqual(["Closed done", "Closed active"]);
    expect(mission.liveGroups).toEqual([]);
    expect(mission.stats).toEqual({ live: 0, review: 1, parked: 1, archived: 2 });
  });

  it("keeps runs that already need attention out of Live now without losing the live count", () => {
    const reviewSession = session("s1", A, 100);
    const mission = selectMissionControl({
      tasks: [task(A, "Needs review", "review", "/repos/store")],
      sessions: [reviewSession],
      attention: [{ key: "s1", session: reviewSession } as AttentionItem]
    });

    expect(mission.liveGroups).toEqual([]);
    expect(mission.stats.live).toBe(1);
  });

  it("falls back to the session directory when the task has no repository", () => {
    const mission = selectMissionControl({
      tasks: [task(A, "No repo", "active")],
      sessions: [session("s1", A, 100)],
      attention: []
    });

    expect(mission.liveGroups[0]?.repository).toBe("fallback");
  });
});

describe("describeLiveRun", () => {
  const conversation = (title: string) => ({ title }) as LiveSession["conversation"];

  it("prefers the cmux tab title over a stale provider title", () => {
    expect(
      describeLiveRun(
        { title: "Claude run · new_dashboard" },
        { conversation: conversation("new-dashboard-0d"), surfaceTitle: "✳ SaaS platform authentication" },
        "new_dashboard"
      )
    ).toEqual({ title: "SaaS platform authentication", detail: null });
  });

  it("uses the conversation title when the tab only shows a path", () => {
    expect(
      describeLiveRun(
        { title: "Codex run · A2A" },
        { conversation: conversation("Auto GTM agent discovery"), surfaceTitle: "…/Documents/GitHub/A2A" },
        "A2A"
      )
    ).toEqual({ title: "Auto GTM agent discovery", detail: null });
  });

  it("falls back to the cleaned cmux tab title", () => {
    expect(
      describeLiveRun(
        { title: "Claude run · pipecat-poc" },
        { conversation: null, surfaceTitle: "[ . ] Action Required | Build ixigo flight reader | pipecat-poc" },
        "pipecat-poc"
      )
    ).toEqual({ title: "Build ixigo flight reader", detail: null });
  });

  it("keeps a task name the user chose and shows the conversation beneath it", () => {
    expect(
      describeLiveRun(
        { title: "Ship 0.6.1" },
        { conversation: null, surfaceTitle: "◑ Last codex session review" },
        "obsidian-agent"
      )
    ).toEqual({ title: "Ship 0.6.1", detail: "Last codex session review" });
  });
});

describe("cleanSurfaceTitle", () => {
  it.each([
    ["✳ Tara Agent prototype dashboard integration", "new_dashboard", "Tara Agent prototype dashboard integration"],
    ["◑ Last codex session review", "obsidian-agent", "Last codex session review"],
    ["Compare Pipecat versions | pipecat-poc", "pipecat-poc", "Compare Pipecat versions"],
    ["Build agentic platform workflow | new_dashboard", "other", "Build agentic platform workflow | new_dashboard"],
    ["…/Documents/GitHub/A2A", "A2A", null],
    ["~/.codex/memories", "A2A", null],
    ["heimdall", "heimdall", null]
  ])("cleans %j", (title, repository, expected) => {
    expect(cleanSurfaceTitle(title, repository)).toBe(expected);
  });
});

describe("lastActiveAt", () => {
  const at = (lastActivityAt: number | null, updatedAt: number | null) =>
    lastActiveAt({
      assessment: { lastActivityAt },
      conversation: updatedAt === null ? null : { updatedAt }
    } as Pick<LiveSession, "assessment" | "conversation">);

  it("uses the newest of screen activity and the provider conversation write", () => {
    expect(at(100, 500)).toBe(500);
    expect(at(900, 500)).toBe(900);
  });

  it("uses the provider time when cmux saw no activity", () => {
    expect(at(null, 500)).toBe(500);
  });

  it("is unknown rather than guessed when neither source has a time", () => {
    expect(at(null, null)).toBeNull();
  });
});
