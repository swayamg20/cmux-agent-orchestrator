import { createHash } from "node:crypto";
import type { CmuxNotification, CmuxPreview } from "../cmux/types";
import type { RuntimeAssessment, RuntimeEvidence } from "../state/types";

interface ObservationHistory {
  previewHash: string | null;
  lastChangedAt: number | null;
}

export interface RuntimeAssessmentInput {
  key: string;
  notifications: readonly CmuxNotification[];
  preview: CmuxPreview | null;
  observedAt: number;
  staleAfterMs: number;
}

const ERROR_PATTERN = /\b(?:error|failed|failure|panic|traceback|exception|unhealthy)\b/i;
const NOTIFICATION_INPUT_PATTERN =
  /\b(?:approve|approval|permission|confirm|waiting for (?:input|you)|needs? input)\b|\[(?:y\/n|yes\/no)\]|continue\?/i;
const REVIEW_PATTERN = /\b(?:ready for review|review requested|completed|finished successfully|implementation complete)\b/i;

function evidence(
  source: RuntimeEvidence["source"],
  confidence: RuntimeEvidence["confidence"],
  observedAt: number,
  explanation: string
): RuntimeEvidence {
  return { source, confidence, observedAt, explanation };
}

export class RuntimeStateEngine {
  private readonly history = new Map<string, ObservationHistory>();

  assess(input: RuntimeAssessmentInput): RuntimeAssessment {
    const unreadText = input.notifications
      .filter((notification) => !notification.isRead)
      .map((notification) => `${notification.title}\n${notification.subtitle}\n${notification.body}`)
      .join("\n");

    const previous = this.history.get(input.key) ?? { previewHash: null, lastChangedAt: null };
    let changedThisObservation = false;
    if (input.preview !== null) {
      const previewHash = createHash("sha256").update(input.preview.text).digest("hex");
      if (previous.previewHash !== null && previous.previewHash !== previewHash) {
        previous.lastChangedAt = input.observedAt;
        changedThisObservation = true;
      }
      previous.previewHash = previewHash;
      this.history.set(input.key, previous);
    }

    if (unreadText && ERROR_PATTERN.test(unreadText)) {
      return {
        state: "error",
        evidence: evidence(
          "cmux-notification",
          "medium",
          input.observedAt,
          "An unread cmux notification contains an error marker."
        ),
        lastObservedChangeAt: previous.lastChangedAt
      };
    }
    if (unreadText && NOTIFICATION_INPUT_PATTERN.test(unreadText)) {
      return {
        state: "needs-input",
        evidence: evidence(
          "cmux-notification",
          "medium",
          input.observedAt,
          "An unread cmux notification appears to request human input."
        ),
        lastObservedChangeAt: previous.lastChangedAt
      };
    }
    if (unreadText && REVIEW_PATTERN.test(unreadText)) {
      return {
        state: "idle",
        evidence: evidence(
          "cmux-notification",
          "medium",
          input.observedAt,
          "An unread cmux notification suggests that output is ready for review."
        ),
        lastObservedChangeAt: previous.lastChangedAt
      };
    }
    if (changedThisObservation) {
      return {
        state: "running",
        evidence: evidence(
          "screen-change",
          "low",
          input.observedAt,
          "The bounded terminal preview changed since it was last observed."
        ),
        lastObservedChangeAt: previous.lastChangedAt
      };
    }
    if (
      input.preview !== null &&
      previous.lastChangedAt !== null &&
      input.observedAt - previous.lastChangedAt >= input.staleAfterMs
    ) {
      return {
        state: "idle",
        evidence: evidence(
          "screen-change",
          "low",
          input.observedAt,
          "No preview change has been observed during the configured stale window."
        ),
        lastObservedChangeAt: previous.lastChangedAt
      };
    }
    return {
      state: "unknown",
      evidence: evidence(
        "surface-presence",
        "low",
        input.observedAt,
        "The cmux surface exists, but the installed command surface does not expose agent lifecycle state."
      ),
      lastObservedChangeAt: previous.lastChangedAt
    };
  }

  clear(): void {
    this.history.clear();
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of this.history.keys()) {
      if (!keys.has(key)) this.history.delete(key);
    }
  }
}
