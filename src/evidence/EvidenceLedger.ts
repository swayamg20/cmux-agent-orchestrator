import type { EvidenceSource, SessionEvidence } from "./types";

export interface EvidenceLedgerLimits {
  perSession: number;
  total: number;
}

const DEFAULT_LIMITS: EvidenceLedgerLimits = {
  perSession: 32,
  total: 2_048
};

export class EvidenceLedger {
  private readonly bySession = new Map<string, SessionEvidence[]>();
  private readonly limits: EvidenceLedgerLimits;

  constructor(limits: Partial<EvidenceLedgerLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (this.limits.perSession < 1 || this.limits.total < 1) {
      throw new Error("Evidence ledger limits must be positive.");
    }
  }

  list(sessionKey: string): readonly SessionEvidence[] {
    return this.bySession.get(sessionKey)?.map((item) => ({ ...item })) ?? [];
  }

  append(evidence: SessionEvidence): void {
    const current = this.bySession.get(evidence.sessionKey) ?? [];
    const withoutDuplicate = current.filter((candidate) => candidate.id !== evidence.id);
    withoutDuplicate.push({ ...evidence });
    withoutDuplicate.sort(compareEvidence);
    this.bySession.set(evidence.sessionKey, withoutDuplicate.slice(-this.limits.perSession));
    this.pruneTotal();
  }

  replaceSource(sessionKey: string, source: EvidenceSource, evidence: readonly SessionEvidence[]): void {
    if (evidence.some((item) => item.sessionKey !== sessionKey || item.source !== source)) {
      throw new Error("Replacement evidence must match the requested session and source.");
    }
    const retained = (this.bySession.get(sessionKey) ?? []).filter((item) => item.source !== source);
    const byId = new Map(retained.map((item) => [item.id, item]));
    for (const item of evidence) byId.set(item.id, { ...item });
    const next = [...byId.values()].sort(compareEvidence).slice(-this.limits.perSession);
    if (next.length === 0) this.bySession.delete(sessionKey);
    else this.bySession.set(sessionKey, next);
    this.pruneTotal();
  }

  retain(sessionKeys: ReadonlySet<string>): void {
    for (const key of this.bySession.keys()) {
      if (!sessionKeys.has(key)) this.bySession.delete(key);
    }
  }

  clear(): void {
    this.bySession.clear();
  }

  get size(): number {
    let size = 0;
    for (const evidence of this.bySession.values()) size += evidence.length;
    return size;
  }

  private pruneTotal(): void {
    let overflow = this.size - this.limits.total;
    while (overflow > 0) {
      let oldestSession: string | null = null;
      let oldestObservedAt = Number.POSITIVE_INFINITY;
      for (const [sessionKey, evidence] of this.bySession) {
        const first = evidence[0];
        if (first && first.observedAt < oldestObservedAt) {
          oldestObservedAt = first.observedAt;
          oldestSession = sessionKey;
        }
      }
      if (oldestSession === null) return;
      const evidence = this.bySession.get(oldestSession)!;
      evidence.shift();
      if (evidence.length === 0) this.bySession.delete(oldestSession);
      overflow -= 1;
    }
  }
}

function compareEvidence(left: SessionEvidence, right: SessionEvidence): number {
  return left.observedAt - right.observedAt || left.id.localeCompare(right.id);
}
