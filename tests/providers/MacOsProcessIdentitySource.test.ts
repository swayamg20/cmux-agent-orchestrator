import { describe, expect, it } from "vitest";
import {
  decodeClaudeProcessSession,
  decodeProviderProcesses,
  decodeWriterLockSessionIds
} from "../../src/providers/identity/MacOsProcessIdentitySource";
import type { ProviderProcess } from "../../src/providers/identity/types";

const claudeProcess: ProviderProcess = {
  pid: 6064,
  parentPid: 5515,
  processGroupId: 6064,
  foregroundProcessGroupId: 6064,
  state: "S+",
  startedAt: "Wed Sep 2 09:49:53 2026",
  executable: "/opt/homebrew/bin/claude",
  provider: "claude"
};

describe("macOS provider identity decoding", () => {
  it("selects only exact Claude and Codex executables from bounded ps output", () => {
    const processes = decodeProviderProcesses(`
 6064  5515  6064  6064 S+   Wed Sep  2 09:49:53 2026     /opt/homebrew/bin/claude
 7825  6963  7825 61955 T    Mon Aug 24 18:50:30 2026     codex
61955  6963 61955 61955 S+   Mon Aug 24 20:04:52 2026     codex
43929 61955 43929 61955 S    Mon Aug 24 21:27:21 2026     /opt/homebrew/Caskroom/codex/0.149.1/bin/codex-code-mode-host
92905  3354  3354     0 S    Tue Aug 25 06:27:12 2026     /Applications/Claude.app/Contents/Helpers/chrome-native-host
`);

    expect(processes).toHaveLength(3);
    expect(processes.map((processRecord) => [processRecord.pid, processRecord.provider])).toEqual([
      [6064, "claude"],
      [7825, "codex"],
      [61955, "codex"]
    ]);
  });

  it("requires Claude PID, UTC start time, CWD, and canonical session ID to agree", () => {
    const raw = {
      pid: 6064,
      procStart: "Wed Sep  2 09:49:53 2026",
      sessionId: "44444444-4444-4444-8444-444444444444",
      cwd: "/workspace/project",
      status: "running"
    };
    expect(decodeClaudeProcessSession(raw, claudeProcess, "/workspace/project")).toEqual({
      sessionId: "44444444-4444-4444-8444-444444444444",
      cwd: "/workspace/project",
      status: "running"
    });
    expect(
      decodeClaudeProcessSession({ ...raw, procStart: "Wed Sep 2 09:49:54 2026" }, claudeProcess, "/workspace/project")
    ).toBeNull();
    expect(decodeClaudeProcessSession(raw, claudeProcess, "/workspace/other")).toBeNull();
  });

  it("accepts only canonical lock names directly inside the Codex writer-lock directory", () => {
    const directory = "/Users/test/.codex/thread-writer-locks";
    expect(
      decodeWriterLockSessionIds(
        [
          "p61955",
          `n${directory}/55555555-5555-4555-8555-555555555555.lock`,
          `n${directory}/not-a-session.lock`,
          "n/tmp/66666666-6666-4666-8666-666666666666.lock"
        ].join("\n"),
        directory
      )
    ).toEqual(["55555555-5555-4555-8555-555555555555"]);
  });
});
