import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../../src/evidence/EvidenceLedger";
import type { SessionEvidence } from "../../src/evidence/types";

function evidence(sessionKey: string, id: string, observedAt: number): SessionEvidence {
  return {
    id,
    kind: "surface-present",
    sessionKey,
    source: "cmux-topology",
    authority: "presence",
    confidence: "high",
    observedAt,
    occurredAt: observedAt,
    summary: "present"
  };
}

describe("EvidenceLedger", () => {
  it("deduplicates evidence and bounds each session plus the global total", () => {
    const ledger = new EvidenceLedger({ perSession: 2, total: 3 });
    ledger.append(evidence("a", "a1", 1));
    ledger.append(evidence("a", "a2", 2));
    ledger.append(evidence("a", "a3", 3));
    ledger.append(evidence("b", "b1", 4));
    ledger.append(evidence("b", "b1", 5));

    expect(ledger.list("a").map((item) => item.id)).toEqual(["a2", "a3"]);
    expect(ledger.list("b")).toHaveLength(1);
    expect(ledger.size).toBe(3);
  });

  it("replaces one source without deleting evidence from other sources", () => {
    const ledger = new EvidenceLedger();
    ledger.append(evidence("a", "topology", 1));
    ledger.append({
      ...evidence("a", "preview", 2),
      kind: "screen-observed",
      source: "terminal-preview",
      authority: "heuristic",
      confidence: "low",
      changed: true,
      activity: "command",
      fingerprint: "abc"
    });
    ledger.replaceSource("a", "cmux-topology", [evidence("a", "new-topology", 3)]);

    expect(ledger.list("a").map((item) => item.id)).toEqual(["preview", "new-topology"]);
  });

  it("drops evidence for surfaces no longer in the current topology", () => {
    const ledger = new EvidenceLedger();
    ledger.append(evidence("a", "a1", 1));
    ledger.append(evidence("b", "b1", 2));
    ledger.retain(new Set(["b"]));
    expect(ledger.list("a")).toEqual([]);
    expect(ledger.list("b")).toHaveLength(1);
  });
});
