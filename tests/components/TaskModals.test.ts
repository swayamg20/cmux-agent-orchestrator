import { Modal, Setting, type App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateTaskModal, taskTitleFromSession } from "../../src/components/TaskModals";
import type { LiveSession } from "../../src/state/types";

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

interface MockButton {
  click: () => void;
  disabledValues: boolean[];
}

interface MockSetting {
  buttons: MockButton[];
  texts: Array<{
    change: (value: string) => void;
    inputEl: { focusCalls: number };
  }>;
}

function settingInstances(): MockSetting[] {
  return (Setting as unknown as { instances: MockSetting[] }).instances;
}

function modalState(modal: CreateTaskModal): { closeCalls: number; opened: boolean } {
  const state = modal as unknown as { closeCalls: number; opened: boolean };
  return { closeCalls: state.closeCalls, opened: state.opened };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("CreateTaskModal lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      clearTimeout,
      setTimeout
    });
    settingInstances().length = 0;
    (Modal as unknown as { instances: unknown[] }).instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not refocus detached content after the modal closes", () => {
    const modal = new CreateTaskModal({} as App, null, async () => undefined);

    modal.open();
    const titleInput = settingInstances()[0]!.texts[0]!.inputEl;
    modal.close();
    vi.runAllTimers();

    expect(titleInput.focusCalls).toBe(0);
  });

  it("focuses the title while the modal remains open", () => {
    const modal = new CreateTaskModal({} as App, null, async () => undefined);

    modal.open();
    const titleInput = settingInstances()[0]!.texts[0]!.inputEl;
    vi.runAllTimers();

    expect(titleInput.focusCalls).toBe(1);
  });

  it("does not close a second time when task creation resolves after close", async () => {
    const creation = deferred<void>();
    const modal = new CreateTaskModal({} as App, null, () => creation.promise);

    modal.open();
    settingInstances()[0]!.texts[0]!.change("Pending task");
    const createButton = settingInstances()[3]!.buttons[1]!;
    createButton.click();
    modal.close();
    creation.resolve(undefined);
    await flushPromises();

    expect(modalState(modal)).toEqual({ closeCalls: 1, opened: false });
    expect(createButton.disabledValues).toEqual([true]);
  });

  it("closes once when task creation resolves while still open", async () => {
    const creation = deferred<void>();
    const modal = new CreateTaskModal({} as App, null, () => creation.promise);

    modal.open();
    settingInstances()[0]!.texts[0]!.change("Pending task");
    const createButton = settingInstances()[3]!.buttons[1]!;
    createButton.click();
    creation.resolve(undefined);
    await flushPromises();

    expect(modalState(modal)).toEqual({ closeCalls: 1, opened: false });
    expect(createButton.disabledValues).toEqual([true]);
  });

  it("does not re-enable detached controls when task creation rejects after close", async () => {
    const creation = deferred<void>();
    const modal = new CreateTaskModal({} as App, null, () => creation.promise);

    modal.open();
    settingInstances()[0]!.texts[0]!.change("Pending task");
    const createButton = settingInstances()[3]!.buttons[1]!;
    createButton.click();
    modal.close();
    creation.reject(new Error("late failure"));
    await creation.promise.catch(() => undefined);
    await flushPromises();

    expect(modalState(modal)).toEqual({ closeCalls: 1, opened: false });
    expect(createButton.disabledValues).toEqual([true]);
  });

  it("re-enables task creation after a failure while still open", async () => {
    const creation = deferred<void>();
    const modal = new CreateTaskModal({} as App, null, () => creation.promise);

    modal.open();
    settingInstances()[0]!.texts[0]!.change("Pending task");
    const createButton = settingInstances()[3]!.buttons[1]!;
    createButton.click();
    creation.reject(new Error("create failure"));
    await creation.promise.catch(() => undefined);
    await flushPromises();

    expect(modalState(modal)).toEqual({ closeCalls: 0, opened: true });
    expect(createButton.disabledValues).toEqual([true, false]);
  });
});

describe("taskTitleFromSession", () => {
  it("does not copy an in-memory provider title into a durable Markdown task", () => {
    const session = {
      surfaceTitle: "project",
      currentDirectory: "/workspace/project",
      conversation: {
        provider: "codex",
        sessionId: "55555555-5555-4555-8555-555555555555",
        title: "Private provider conversation title",
        titleSource: "explicit-name",
        cwd: "/workspace/project",
        updatedAt: 1_000,
        status: "idle",
        matchSource: "manual",
        matchConfidence: "high"
      }
    } as LiveSession;

    expect(taskTitleFromSession(session)).toBe("project: project");
  });
});
