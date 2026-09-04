import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("read-only live test harness", () => {
  it("runs suites serially against the shared cmux process", async () => {
    const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const command = packageJson.scripts?.["test:live:read-only"] ?? "";

    expect(command).toContain("--no-file-parallelism");
    expect(command).toMatch(/--maxWorkers(?:=|\s+)1(?:\s|$)/);
  });
});
