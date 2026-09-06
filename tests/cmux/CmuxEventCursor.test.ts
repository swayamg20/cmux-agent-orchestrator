import { describe, expect, it } from "vitest";
import { CmuxEventCursor } from "../../src/cmux/CmuxEventCursor";

const BOOT_A = "11111111-1111-4111-8111-111111111111";
const BOOT_B = "22222222-2222-4222-8222-222222222222";

function frame(value: Record<string, unknown>): string {
  return JSON.stringify({
    protocol: "cmux-events",
    version: 1,
    boot_id: BOOT_A,
    ...(value.type === "ack" ? { heartbeat_interval_seconds: 15 } : {}),
    ...value
  });
}

describe("CmuxEventCursor", () => {
  it("reduces relevant events to content-free refresh scopes", () => {
    const cursor = new CmuxEventCursor();
    expect(cursor.accept(frame({ type: "ack", resume: { gap: false } }))).toEqual({
      frameType: "ack",
      heartbeatIntervalSeconds: 15,
      signal: null
    });
    expect(
      cursor.accept(
        frame({ type: "event", seq: 1, name: "surface.created", category: "surface" })
      )
    ).toEqual({
      frameType: "event",
      heartbeatIntervalSeconds: null,
      signal: {
        scope: "topology",
        bootId: BOOT_A,
        seq: 1,
        name: "surface.created",
        reason: "change"
      }
    });
    expect(
      cursor.accept(
        frame({ type: "event", seq: 2, name: "notification.created", category: "notification" })
      )
    ).toMatchObject({ signal: { scope: "notifications", seq: 2 } });
    expect(
      cursor.accept(
        frame({ type: "event", seq: 3, name: "agent.hook.Stop", category: "agent" })
      )
    ).toMatchObject({ signal: { scope: "lifecycle", seq: 3 } });
  });

  it("advances across ignored categories so global sequence gaps remain meaningful", () => {
    const cursor = new CmuxEventCursor();
    cursor.accept(frame({ type: "ack", resume: { gap: false } }));
    expect(
      cursor.accept(frame({ type: "event", seq: 8, name: "browser.navigation", category: "browser" }))
    ).toMatchObject({ frameType: "event", signal: null });
    expect(
      cursor.accept(frame({ type: "event", seq: 9, name: "workspace.created", category: "workspace" }))
    ).toMatchObject({ signal: { scope: "topology", reason: "change" } });
  });

  it("requests a full resync for resume gaps, sequence gaps, and boot changes", () => {
    const cursor = new CmuxEventCursor();
    expect(cursor.accept(frame({ type: "ack", resume: { gap: true } }))).toMatchObject({
      signal: { scope: "resync", reason: "resume-gap" }
    });
    cursor.accept(frame({ type: "event", seq: 20, name: "surface.created", category: "surface" }));
    expect(
      cursor.accept(frame({ type: "event", seq: 22, name: "surface.closed", category: "surface" }))
    ).toMatchObject({ signal: { scope: "resync", reason: "sequence-gap", seq: 22 } });
    expect(
      cursor.accept(
        JSON.stringify({
          protocol: "cmux-events",
          version: 1,
          type: "ack",
          boot_id: BOOT_B,
          heartbeat_interval_seconds: 15,
          resume: { gap: false }
        })
      )
    ).toMatchObject({
      frameType: "ack",
      signal: { scope: "resync", reason: "boot-changed", bootId: BOOT_B }
    });
  });

  it("requires a bounded heartbeat interval and an acknowledgement before data", () => {
    const cursor = new CmuxEventCursor();
    expect(() =>
      cursor.accept(frame({ type: "event", seq: 1, name: "surface.created", category: "surface" }))
    ).toThrow(/before its acknowledgement/);
    expect(() =>
      cursor.accept(frame({ type: "ack", heartbeat_interval_seconds: 0, resume: { gap: false } }))
    ).toThrow(/positive safe integer/);
    expect(() =>
      cursor.accept(frame({
        type: "ack",
        heartbeat_interval_seconds: 715_828,
        resume: { gap: false }
      }))
    ).toThrow(/no greater than 715827/);
  });

  it("rejects malformed or unsupported frames", () => {
    const cursor = new CmuxEventCursor();
    expect(() => cursor.accept("not-json")).toThrow(/invalid JSON/);
    expect(() => cursor.accept(frame({ type: "event", seq: -1, name: "x", category: "surface" }))).toThrow(
      /non-negative safe integer/
    );
    expect(() => cursor.accept(JSON.stringify({ type: "ack", protocol: "other", version: 1, boot_id: BOOT_A }))).toThrow(
      /protocol is unsupported/
    );
  });
});
