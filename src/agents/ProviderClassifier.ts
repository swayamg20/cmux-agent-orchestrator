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

export interface ProviderSurfaceIdentity {
  key: string;
  surfaceTitle: string;
  surfaceType: string;
  currentDirectory: string | null;
}

export class ProviderClassifier {
  private readonly detections = new Map<string, ProviderDetection>();
  private readonly attempted = new Map<string, string>();
  private readonly surfaceSignatures = new Map<string, string>();
  private generation = 0;

  constructor(
    private readonly detector: AgentDetector,
    private readonly scheduler: PreviewScheduler
  ) {}

  get evidence(): ReadonlyMap<string, ProviderDetection> {
    return this.detections;
  }

  detect(session: LiveSession, previewText: string): ProviderDetection | null {
    const signature = surfaceSignature(session);
    const currentSignature = this.surfaceSignatures.get(session.key);
    if (currentSignature !== undefined && currentSignature !== signature) return null;
    this.surfaceSignatures.set(session.key, signature);
    const detection = this.detector.detect(surfaceForDetection(session), previewText);
    this.record(session.key, detection);
    return detection;
  }

  classifyNew(sessions: readonly LiveSession[], client: CmuxClient): Promise<ProviderObservation[]> | null {
    const generation = this.generation;
    const candidates = sessions.filter(
      (session) =>
        session.surfaceType === "terminal" &&
        session.provider.provider === "unknown" &&
        this.attempted.get(session.key) !== surfaceSignature(session)
    );
    if (candidates.length === 0) return null;
    for (const session of candidates) {
      const signature = surfaceSignature(session);
      this.surfaceSignatures.set(session.key, signature);
      this.attempted.set(session.key, signature);
    }
    return Promise.allSettled(
      candidates.map((session) =>
        this.scheduler
          .schedule(`provider:${generation}:${session.key}:${surfaceSignature(session)}`, () =>
            client.readPreview(session, {
              lines: PROVIDER_EVIDENCE_LINES,
              maxBytes: PROVIDER_EVIDENCE_MAX_BYTES
            })
          )
          .then((preview) => ({ session, preview }))
      )
    ).then((results) => {
      if (generation !== this.generation) return [];
      const observations: ProviderObservation[] = [];
      for (const [index, result] of results.entries()) {
        if (result.status !== "fulfilled") {
          const failed = candidates[index];
          if (failed && this.attempted.get(failed.key) === surfaceSignature(failed)) {
            this.attempted.delete(failed.key);
          }
          continue;
        }
        const detection = this.detect(result.value.session, result.value.preview.text);
        if (detection === null) continue;
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

  syncSurfaces(surfaces: readonly ProviderSurfaceIdentity[]): ReadonlySet<string> {
    const keys = new Set(surfaces.map((surface) => surface.key));
    const invalidated = new Set<string>();
    for (const surface of surfaces) {
      const signature = surfaceSignature(surface);
      const previous = this.surfaceSignatures.get(surface.key);
      if (previous !== undefined && previous !== signature) {
        this.detections.delete(surface.key);
        this.attempted.delete(surface.key);
        invalidated.add(surface.key);
      }
      this.surfaceSignatures.set(surface.key, signature);
    }
    retainMap(this.detections, keys);
    retainMap(this.attempted, keys);
    retainMap(this.surfaceSignatures, keys);
    return invalidated;
  }

  clear(): void {
    this.generation += 1;
    this.detections.clear();
    this.attempted.clear();
    this.surfaceSignatures.clear();
  }

  private record(key: string, detection: ProviderDetection): void {
    const signature = this.surfaceSignatures.get(key);
    if (signature !== undefined) this.attempted.set(key, signature);
    if (detection.provider === "claude" || detection.provider === "codex") {
      this.detections.set(key, detection);
    }
  }
}

function surfaceSignature(surface: ProviderSurfaceIdentity): string {
  return JSON.stringify([surface.surfaceTitle, surface.surfaceType, surface.currentDirectory]);
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
