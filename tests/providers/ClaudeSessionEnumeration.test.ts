import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  opendir: vi.fn(),
  readdir: vi.fn(),
  readBoundedUtf8File: vi.fn()
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    opendir: fsMocks.opendir,
    readdir: fsMocks.readdir
  };
});

vi.mock("../../src/providers/readBoundedFile", () => ({
  readBoundedUtf8File: fsMocks.readBoundedUtf8File
}));

import { ClaudeSessionSource } from "../../src/providers/ClaudeSessionSource";

interface FakeDirectoryEntry {
  name: string;
  isFile(): boolean;
}

function directoryEntry(name: string, file: boolean): FakeDirectoryEntry {
  return { name, isFile: () => file };
}

function fakeDirectory(entries: FakeDirectoryEntry[]): {
  read: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  let cursor = 0;
  return {
    read: vi.fn(async () => entries[cursor++] ?? null),
    close: vi.fn(async () => undefined)
  };
}

describe("ClaudeSessionSource bounded directory enumeration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("opens at most 200 registry files while skipping unrelated entries", async () => {
    const entries = [
      ...Array.from({ length: 250 }, (_, index) =>
        directoryEntry(`ignored-${String(index).padStart(4, "0")}`, false)
      ),
      ...Array.from({ length: 900 }, (_, index) =>
        directoryEntry(`session-${String(index).padStart(4, "0")}.json`, true)
      )
    ];
    const directory = fakeDirectory(entries);
    fsMocks.opendir.mockResolvedValue(directory);
    fsMocks.readdir.mockRejectedValue(new Error("unbounded readdir must not be used"));
    fsMocks.readBoundedUtf8File.mockResolvedValue(null);
    const source = new ClaudeSessionSource("/provider-root");

    await expect(source.list("/repository")).resolves.toEqual([]);

    expect(fsMocks.readdir).not.toHaveBeenCalled();
    expect(directory.read).toHaveBeenCalledTimes(450);
    expect(fsMocks.readBoundedUtf8File).toHaveBeenCalledTimes(200);
    expect(directory.close).toHaveBeenCalledTimes(1);
  });

  it("examines at most 1,000 unrelated directory entries", async () => {
    const entries = [
      ...Array.from({ length: 1_000 }, (_, index) =>
        directoryEntry(`ignored-${String(index).padStart(4, "0")}`, false)
      ),
      directoryEntry("session-after-limit.json", true)
    ];
    const directory = fakeDirectory(entries);
    fsMocks.opendir.mockResolvedValue(directory);
    fsMocks.readBoundedUtf8File.mockResolvedValue(null);
    const source = new ClaudeSessionSource("/provider-root");

    await expect(source.list("/repository")).resolves.toEqual([]);

    expect(directory.read).toHaveBeenCalledTimes(1_000);
    expect(fsMocks.readBoundedUtf8File).not.toHaveBeenCalled();
    expect(directory.close).toHaveBeenCalledTimes(1);
  });

  it("closes the directory when enumeration is cancelled", async () => {
    const controller = new AbortController();
    const directory = fakeDirectory([directoryEntry("session.json", true)]);
    directory.read.mockImplementationOnce(async () => {
      controller.abort();
      return directoryEntry("session.json", true);
    });
    fsMocks.opendir.mockResolvedValue(directory);
    const source = new ClaudeSessionSource("/provider-root");

    await expect(source.list("/repository", controller.signal)).rejects.toMatchObject({
      name: "AbortError"
    });

    expect(fsMocks.readBoundedUtf8File).not.toHaveBeenCalled();
    expect(directory.close).toHaveBeenCalledTimes(1);
  });
});
