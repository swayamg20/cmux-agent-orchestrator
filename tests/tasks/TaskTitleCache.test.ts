import { describe, expect, it } from "vitest";
import type { LiveSession } from "../../src/state/types";
import type { TaskRecord } from "../../src/tasks/TaskSchema";
import {
  TASK_TITLE_STORAGE_KEY,
  TaskTitleCache,
  displayTaskTitle,
  type TitleStorage
} from "../../src/tasks/TaskTitleCache";
import { selectWorkBoardTasks } from "../../src/views/WorkBoardModel";

const TASK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function memoryStorage(initial: unknown = null): TitleStorage & { saved: unknown[] } {
  let value = initial;
  const saved: unknown[] = [];
  return {
    saved,
    load: (key) => (key === TASK_TITLE_STORAGE_KEY ? value : null),
    save: (_key, data) => {
      value = data;
      saved.push(data);
    }
  };
}

function task(title: string): TaskRecord {
  return { taskId: TASK_ID, title, repository: "/repos/new_dashboard", workflowStatus: "active" } as TaskRecord;
}

function session(surfaceTitle: string, surfacePresence: "present" | "missing" = "present"): LiveSession {
  return {
    linkedTaskId: TASK_ID,
    surfaceTitle,
    conversation: null,
    currentDirectory: "/repos/new_dashboard",
    assessment: { surfacePresence }
  } as LiveSession;
}

describe("TaskTitleCache", () => {
  it("remembers the tab title of an auto-named task and persists it locally", () => {
    const storage = memoryStorage();
    const cache = new TaskTitleCache(storage);
    const titles = cache.observe([task("Claude run · new_dashboard")], [session("✳ SaaS platform auth")]);

    expect(titles).toEqual({ [TASK_ID]: "SaaS platform auth" });
    expect(storage.saved).toHaveLength(1);
    expect(new TaskTitleCache(storage).current()).toEqual(titles);
  });

  it("keeps the last title after the session closes and skips redundant saves", () => {
    const storage = memoryStorage();
    const cache = new TaskTitleCache(storage);
    const auto = task("Claude run · new_dashboard");
    const first = cache.observe([auto], [session("✳ SaaS platform auth")]);
    const again = cache.observe([auto], [session("◑ SaaS platform auth")]);
    const closed = cache.observe([auto], [session("anything", "missing")]);

    expect(again).toBe(first);
    expect(closed).toBe(first);
    expect(storage.saved).toHaveLength(1);
    expect(displayTaskTitle(auto, closed)).toBe("SaaS platform auth");
  });

  it("never caches over a task name the user chose", () => {
    const cache = new TaskTitleCache(memoryStorage());
    expect(cache.observe([task("Ship 0.6.1")], [session("✳ SaaS platform auth")])).toEqual({});
  });

  it("ignores malformed stored data", () => {
    const cache = new TaskTitleCache(memoryStorage({ "not-a-uuid": "x", [TASK_ID]: 42 }));
    expect(cache.current()).toEqual({});
  });

  it("works without local storage", () => {
    const cache = new TaskTitleCache(null);
    expect(cache.observe([task("Codex run · x")], [session("Real work")])).toEqual({ [TASK_ID]: "Real work" });
  });
});

describe("board search", () => {
  it("matches the remembered descriptive title", () => {
    const auto = task("Claude run · new_dashboard");
    const state = { tasks: [auto], sessions: [], taskTitles: { [TASK_ID]: "SaaS platform auth" } };
    expect(selectWorkBoardTasks(state, "saas", "all").tasks).toEqual([auto]);
  });
});
