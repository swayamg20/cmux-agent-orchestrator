import { describe, expect, it } from "vitest";
import {
  CMUX_SETUP_CLIPBOARD_TEXT,
  cmuxConnectionGuidance
} from "../../src/cmux/accessSetup";
import type { ConnectionState } from "../../src/state/types";

function connection(
  status: ConnectionState["status"],
  accessMode: ConnectionState["accessMode"] = null
): ConnectionState {
  return {
    status,
    accessMode,
    message: "test",
    versionText: null,
    binaryPath: null,
    checkedAt: 1
  };
}

describe("cmux connection onboarding", () => {
  it("requires setup for external denial and development-only process access", () => {
    expect(cmuxConnectionGuidance(connection("access-blocked"))).toBe("setup");
    expect(cmuxConnectionGuidance(connection("connected", "cmuxOnly"))).toBe("setup");
  });

  it("accepts password and automation modes without showing onboarding", () => {
    expect(cmuxConnectionGuidance(connection("connected", "password"))).toBeNull();
    expect(cmuxConnectionGuidance(connection("connected", "automation"))).toBeNull();
  });

  it("warns about full open access and separates ordinary unavailability", () => {
    expect(cmuxConnectionGuidance(connection("connected", "allowAll"))).toBe("unsafe");
    expect(cmuxConnectionGuidance(connection("disconnected"))).toBe("unavailable");
  });

  it("provides GUI-only setup steps without asking the orchestrator to handle a secret", () => {
    expect(CMUX_SETUP_CLIPBOARD_TEXT).toContain("Settings");
    expect(CMUX_SETUP_CLIPBOARD_TEXT).toContain("Password mode");
    expect(CMUX_SETUP_CLIPBOARD_TEXT).toContain("cmux Agent Orchestrator never receives it");
    expect(CMUX_SETUP_CLIPBOARD_TEXT).not.toContain("cmux --password");
    expect(CMUX_SETUP_CLIPBOARD_TEXT).not.toContain("socketPassword");
  });
});
