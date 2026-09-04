import type { CmuxClient } from "../cmux/CmuxClient";
import type { CmuxSurface } from "../cmux/types";
import type { PreviewScheduler } from "../runtime/PreviewScheduler";
import type { LiveSession, ProviderDetection } from "../state/types";
import type { AgentDetector } from "./AgentDetector";

const PROVIDER_EVIDENCE_LINES = 500;
const PROVIDER_EVIDENCE_MAX_BYTES = 64 * 1024;

export interface ProviderObservation {
  key: string;
  detection: ProviderDetection;
  observedAt: number;
}

export class ProviderClassifier {
  private readonly detections = new Map<string, ProviderDetection>();
  private readonly attempted = new Set<string>();

  constructor(
    private readonly detector: AgentDetector,
    private readonly scheduler: PreviewScheduler
  ) {}

  get evidence(): ReadonlyMap<string, ProviderDetection> {
    return this.detections;
  }

  record(key: string, detection: ProviderDetection): void {
    this.attempted.add(key);
    if (detection.provider === "claude" || detection.provider === "codex") {
      this.detections.set(key, detection);
    }
  }

  detect(session: LiveSession, previewText: string): ProviderDetection {
    const detection = this.detector.detect(surfaceForDetection(session), previewText);
    this.record(session.key, detection);
    return detection;
  }

  classifyNew(sessions: readonly LiveSession[], client: CmuxClient): Promise<ProviderObservation[]> | null {
    const candidates = sessions.filter(
      (session) =>
        session.surfaceType === "terminal" &&
        session.provider.provider === "unknown" &&
        !this.attempted.has(session.key)
    );
    if (candidates.length === 0) return null;
    for (const session of candidates) this.attempted.add(session.key);
    return Promise.allSettled(
      candidates.map((session) =>
        this.scheduler
          .schedule(`provider:${session.key}`, () =>
            client.readPreview(session, {
              lines: PROVIDER_EVIDENCE_LINES,
              maxBytes: PROVIDER_EVIDENCE_MAX_BYTES
            })
          )
          .then((preview) => ({ session, preview }))
      )
    ).then((results) => {
      const observations: ProviderObservation[] = [];
      for (const [index, result] of results.entries()) {
        if (result.status !== "fulfilled") {
          const failed = candidates[index];
          if (failed) this.attempted.delete(failed.key);
          continue;
        }
        const detection = this.detect(result.value.session, result.value.preview.text);
        if (detection.provider === "claude" || detection.provider === "codex") {
          observations.push({
            key: result.value.session.key,
            detection,
            observedAt: result.value.preview.observedAt
          });
        }
      }
      return observations;
    });
  }

  retain(keys: ReadonlySet<string>): void {
    retainMap(this.detections, keys);
    for (const key of this.attempted) if (!keys.has(key)) this.attempted.delete(key);
  }

  clear(): void {
    this.detections.clear();
    this.attempted.clear();
  }
}

function surfaceForDetection(session: LiveSession): CmuxSurface {
  return {
    id: session.surfaceId,
    paneId: session.paneId,
    index: session.surfaceIndex,
    indexInPane: session.surfaceIndex,
    title: session.surfaceTitle,
    type: session.surfaceType,
    selected: false,
    focused: false,
    active: false
  };
}

function retainMap<T>(values: Map<string, T>, keys: ReadonlySet<string>): void {
  for (const key of values.keys()) if (!keys.has(key)) values.delete(key);
}
