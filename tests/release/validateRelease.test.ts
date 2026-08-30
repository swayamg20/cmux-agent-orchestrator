import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateRelease } from "../../scripts/validate-release.mjs";

const temporaryDirectories: string[] = [];

async function createReleaseFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-plugin-release-"));
  temporaryDirectories.push(root);
  await Promise.all([
    writeFile(path.join(root, "README.md"), "# Test\n", "utf8"),
    writeFile(path.join(root, "LICENSE"), "Test license\n", "utf8"),
    writeFile(path.join(root, "main.js"), "module.exports = {};\n", "utf8"),
    writeFile(path.join(root, "styles.css"), ".test {}\n", "utf8"),
    writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify({
        id: "test-deck",
        name: "Test Deck",
        version: "0.1.0",
        minAppVersion: "1.10.0",
        description: "Observe cmux agent sessions.",
        author: "Swayam Gupta",
        isDesktopOnly: true
      }),
      "utf8"
    ),
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "test-deck",
        version: "0.1.0",
        author: "Swayam Gupta",
        license: "MIT",
        private: true,
        repository: { url: "https://github.com/example/test-deck" }
      }),
      "utf8"
    ),
    writeFile(path.join(root, "versions.json"), JSON.stringify({ "0.1.0": "1.10.0" }), "utf8")
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("release validation", () => {
  it("accepts a complete Obsidian desktop plugin release", async () => {
    const root = await createReleaseFixture();
    await expect(validateRelease(root, "0.1.0")).resolves.toEqual([]);
  });

  it("rejects tag and package version drift", async () => {
    const root = await createReleaseFixture();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "test-deck",
        version: "0.2.0",
        author: "Swayam Gupta",
        license: "MIT",
        private: true,
        repository: { url: "https://github.com/example/test-deck" }
      }),
      "utf8"
    );

    const errors = await validateRelease(root, "0.2.0");
    expect(errors).toContain("Release tag 0.2.0 must exactly match manifest.version 0.1.0.");
    expect(errors).toContain("package.json and manifest.json versions must match.");
  });

  it("rejects the redundant platform name in the manifest description", async () => {
    const root = await createReleaseFixture();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.description = "Observe cmux agent sessions from Obsidian.";
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    const errors = await validateRelease(root, "0.1.0");
    expect(errors).toContain("manifest.description must not contain the redundant word Obsidian.");
  });
});
