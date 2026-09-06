import { CmuxError, type CmuxEventRefreshScope, type CmuxEventSignal } from "./types";
import { normalizeCanonicalUuid } from "../security/identifiers";

type JsonRecord = Record<string, unknown>;

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MISSED_HEARTBEAT_LIMIT = 3;
const MAX_HEARTBEAT_INTERVAL_SECONDS = Math.floor(
  MAX_TIMER_DELAY_MS / MISSED_HEARTBEAT_LIMIT / 1_000
);

type CmuxEventFrame =
  | {
      type: "ack";
      bootId: string;
      resumeGap: boolean;
      heartbeatIntervalSeconds: number;
    }
  | { type: "heartbeat"; bootId: string }
  | { type: "event"; bootId: string; seq: number; name: string; category: string };

export type CmuxEventCursorUpdate =
  | {
      frameType: "ack";
      heartbeatIntervalSeconds: number;
      signal: CmuxEventSignal | null;
    }
  | {
      frameType: "heartbeat" | "event";
      heartbeatIntervalSeconds: null;
      signal: CmuxEventSignal | null;
    };

/**
 * Reduces JSONL event envelopes to refresh signals while retaining only the
 * in-memory boot/sequence cursor needed for gap detection.
 */
export class CmuxEventCursor {
  private bootId: string | null = null;
  private lastSeq: number | null = null;
  private acknowledged = false;

  accept(line: string): CmuxEventCursorUpdate {
    const frame = decodeCmuxEventFrame(line);
    if (frame.type === "ack") {
      const bootChanged = this.bootId !== null && this.bootId !== frame.bootId;
      this.bootId = frame.bootId;
      this.acknowledged = true;
      if (bootChanged || frame.resumeGap) this.lastSeq = null;
      const signal = bootChanged
        ? resyncSignal(frame.bootId, null, "boot-changed")
        : frame.resumeGap
          ? resyncSignal(frame.bootId, null, "resume-gap")
          : null;
      return {
        frameType: "ack",
        heartbeatIntervalSeconds: frame.heartbeatIntervalSeconds,
        signal
      };
    }

    if (!this.acknowledged) {
      throw new CmuxError(
        "malformed-output",
        "cmux event stream emitted a frame before its acknowledgement."
      );
    }

    if (frame.type === "heartbeat") {
      let signal: CmuxEventSignal | null = null;
      if (this.bootId !== null && this.bootId !== frame.bootId) {
        this.bootId = frame.bootId;
        this.lastSeq = null;
        signal = resyncSignal(frame.bootId, null, "boot-changed");
      } else {
        this.bootId = frame.bootId;
      }
      return { frameType: "heartbeat", heartbeatIntervalSeconds: null, signal };
    }

    let signal: CmuxEventSignal | null;
    if (this.bootId !== null && this.bootId !== frame.bootId) {
      this.bootId = frame.bootId;
      this.lastSeq = frame.seq;
      signal = resyncSignal(frame.bootId, frame.seq, "boot-changed");
    } else {
      this.bootId = frame.bootId;
      if (this.lastSeq !== null && frame.seq === this.lastSeq) {
        signal = null;
      } else if (this.lastSeq !== null && frame.seq !== this.lastSeq + 1) {
        this.lastSeq = frame.seq;
        signal = resyncSignal(frame.bootId, frame.seq, "sequence-gap");
      } else {
        this.lastSeq = frame.seq;
        const scope = refreshScope(frame.category);
        signal = scope === null
          ? null
          : {
              scope,
              bootId: frame.bootId,
              seq: frame.seq,
              name: frame.name,
              reason: "change"
            };
      }
    }
    return { frameType: "event", heartbeatIntervalSeconds: null, signal };
  }
}

function decodeCmuxEventFrame(line: string): CmuxEventFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch (error) {
    throw new CmuxError("malformed-output", "cmux event stream emitted invalid JSON.", error);
  }
  const root = record(raw, "cmux event frame");
  if (root.protocol !== "cmux-events" || root.version !== 1) {
    throw new CmuxError("malformed-output", "cmux event stream protocol is unsupported.");
  }
  const bootId = canonicalUuid(root.boot_id, "cmux event frame.boot_id");
  if (root.type === "ack") {
    const resume = root.resume === undefined ? null : record(root.resume, "cmux event frame.resume");
    return {
      type: "ack",
      bootId,
      resumeGap: resume?.gap === true,
      heartbeatIntervalSeconds: positiveSafeInteger(
        root.heartbeat_interval_seconds,
        "cmux event frame.heartbeat_interval_seconds",
        MAX_HEARTBEAT_INTERVAL_SECONDS
      )
    };
  }
  if (root.type === "heartbeat") return { type: "heartbeat", bootId };
  if (root.type !== "event") {
    throw new CmuxError("malformed-output", "cmux event stream frame type is unsupported.");
  }
  return {
    type: "event",
    bootId,
    seq: nonNegativeSafeInteger(root.seq, "cmux event frame.seq"),
    name: boundedString(root.name, "cmux event frame.name", 256),
    category: boundedString(root.category, "cmux event frame.category", 64)
  };
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CmuxError("malformed-output", `${label} must be an object.`);
  }
  return value as JsonRecord;
}

function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new CmuxError("malformed-output", `${label} must be a string.`);
  }
  const normalized = normalizeCanonicalUuid(value);
  if (normalized === null) {
    throw new CmuxError("malformed-output", `${label} must be a canonical UUID.`);
  }
  return normalized;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CmuxError("malformed-output", `${label} must be a non-negative safe integer.`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new CmuxError(
      "malformed-output",
      `${label} must be a positive safe integer no greater than ${String(maximum)}.`
    );
  }
  return value;
}

function boundedString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new CmuxError("malformed-output", `${label} is invalid.`);
  }
  return value;
}

function refreshScope(category: string): Exclude<CmuxEventRefreshScope, "resync"> | null {
  if (category === "window" || category === "workspace" || category === "pane" || category === "surface") {
    return "topology";
  }
  if (category === "notification") return "notifications";
  if (category === "agent" || category === "feed") return "lifecycle";
  return null;
}

function resyncSignal(
  bootId: string,
  seq: number | null,
  reason: Exclude<CmuxEventSignal["reason"], "change">
): CmuxEventSignal {
  return { scope: "resync", bootId, seq, name: null, reason };
}
