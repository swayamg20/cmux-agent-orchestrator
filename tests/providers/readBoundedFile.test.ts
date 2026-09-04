import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBoundedUtf8File } from "../../src/providers/readBoundedFile";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryFile(content: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cmux-agent-bounded-file-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "session.json");
  await writeFile(filename, content);
  return filename;
}

describe("readBoundedUtf8File", () => {
  it("reads an exact bounded snapshot and its metadata from one open handle", async () => {
    const filename = await temporaryFile("bounded metadata");

    const result = await readBoundedUtf8File(filename, Buffer.byteLength("bounded metadata"));

    expect(result?.content).toBe("bounded metadata");
    expect(result?.modifiedAt).toEqual(expect.any(Number));
  });

  it("rejects content beyond the byte limit", async () => {
    const filename = await temporaryFile("x".repeat(65));

    await expect(readBoundedUtf8File(filename, 64)).resolves.toBeNull();
  });

  it("honors cancellation before opening provider metadata", async () => {
    const filename = await temporaryFile("bounded metadata");
    const controller = new AbortController();
    controller.abort();

    await expect(readBoundedUtf8File(filename, 64, controller.signal)).rejects.toMatchObject({
      name: "AbortError"
    });
  });
});
