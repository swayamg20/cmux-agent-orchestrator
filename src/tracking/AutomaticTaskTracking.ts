import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { AgentRunRecord } from "../bindings/types";
import { isCanonicalUuid } from "../security/identifiers";
import type { LiveSession, ProviderDetection } from "../state/types";

type TrackableProvider = "claude" | "codex";

export interface AutomaticTrackCandidate {
  session: LiveSession;
  provider: TrackableProvider;
  providerSessionId: string;
  taskId: string;
}

const EXACT_SOURCES = new Set<ProviderDetection["source"]>([
  "provider-session-mapping",
  "cmux-agent-registry",
  "claude-process-registry",
  "codex-writer-lock"
]);

/**
 * Selects only exact, unique provider sessions that have never been tracked.
 * A retained run record acts as a durable tombstone after a manual detach or
 * task deletion, so a later refresh cannot silently recreate the work item.
 */
export function selectAutomaticTrackCandidates(
  sessions: readonly LiveSession[],
  runs: readonly AgentRunRecord[]
): AutomaticTrackCandidate[] {
  const knownRuns = new Set(
    runs.flatMap((run) =>
      isTrackableProvider(run.provider) && run.providerSessionId !== null
        ? [providerSessionKey(run.provider, run.providerSessionId)]
        : []
    )
  );
  const grouped = new Map<string, Array<{ session: LiveSession; provider: TrackableProvider; sessionId: string }>>();

  for (const session of sessions) {
    const identity = exactTrackableIdentity(session);
    if (identity === null) continue;
    const key = providerSessionKey(identity.provider, identity.sessionId);
    const group = grouped.get(key) ?? [];
    group.push({ session, ...identity });
    grouped.set(key, group);
  }

  const candidates: AutomaticTrackCandidate[] = [];
  for (const [key, group] of grouped) {
    if (group.length !== 1 || knownRuns.has(key)) continue;
    const match = group[0]!;
    if (match.session.linkedTaskId !== null) continue;
    candidates.push({
      session: match.session,
      provider: match.provider,
      providerSessionId: match.sessionId,
      taskId: automaticTaskId(match.provider, match.sessionId)
    });
  }

  return candidates.sort((left, right) => left.session.key.localeCompare(right.session.key));
}

export function exactTrackableIdentity(
  session: LiveSession
): { provider: TrackableProvider; sessionId: string } | null {
  const { provider } = session;
  if (
    !isTrackableProvider(provider.provider) ||
    provider.confidence !== "high" ||
    !EXACT_SOURCES.has(provider.source) ||
    provider.sessionId === null ||
    !isCanonicalUuid(provider.sessionId)
  ) {
    return null;
  }
  return { provider: provider.provider, sessionId: provider.sessionId };
}

export function automaticTaskId(provider: TrackableProvider, providerSessionId: string): string {
  if (!isCanonicalUuid(providerSessionId)) throw new Error("Provider session ID is not a canonical UUID.");
  const characters = createHash("sha256")
    .update(`cmux-agent-orchestrator\0automatic-task\0${provider}\0${providerSessionId}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  characters[12] = "5";
  characters[16] = "89ab"[Number.parseInt(characters[16]!, 16) % 4]!;
  return `${characters.slice(0, 8).join("")}-${characters.slice(8, 12).join("")}-${characters.slice(12, 16).join("")}-${characters.slice(16, 20).join("")}-${characters.slice(20).join("")}`;
}

/** Keeps private provider conversation titles out of automatically written Markdown. */
export function automaticTaskTitle(session: LiveSession, provider: TrackableProvider): string {
  const providerName = provider === "claude" ? "Claude" : "Codex";
  const repository = repositoryName(session.currentDirectory);
  return repository === null ? `${providerName} agent run` : `${providerName} run · ${repository}`;
}

export function providerSessionKey(provider: TrackableProvider, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

function isTrackableProvider(value: string): value is TrackableProvider {
  return value === "claude" || value === "codex";
}

function repositoryName(currentDirectory: string | null): string | null {
  if (currentDirectory === null) return null;
  const value = basename(currentDirectory.replace(/[\\/]+$/, ""))
    .replace(/[\r\n\0]+/g, " ")
    .trim()
    .slice(0, 200);
  return value || null;
}
