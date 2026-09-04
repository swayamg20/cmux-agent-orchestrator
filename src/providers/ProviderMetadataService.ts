import type { LiveSession } from "../state/types";
import { normalizeCanonicalUuid } from "../security/identifiers";
import { ClaudeSessionSource } from "./ClaudeSessionSource";
import { CodexAppServerSource } from "./CodexAppServerSource";
import type {
  ProviderSessionKind,
  ProviderSessionMetadata,
  ProviderSessionReference,
  ProviderSessionSource
} from "./types";

const METADATA_CONCURRENCY = 2;
const MAX_METADATA_ENTRIES = 1_000;

export class ProviderMetadataService {
  private readonly sources: ReadonlyMap<ProviderSessionKind, ProviderSessionSource>;
  private readonly metadata = new Map<string, ProviderSessionMetadata>();
  private readonly controllers = new Set<AbortController>();
  private disposed = false;

  constructor(
    sources: readonly ProviderSessionSource[] = [new ClaudeSessionSource(), new CodexAppServerSource()]
  ) {
    this.sources = new Map(sources.map((source) => [source.provider, source]));
  }

  get evidence(): ReadonlyMap<string, ProviderSessionMetadata> {
    return this.metadata;
  }

  async list(
    provider: ProviderSessionKind,
    cwd: string,
    signal?: AbortSignal
  ): Promise<ProviderSessionMetadata[]> {
    const request = this.beginRequest(signal);
    try {
      const sessions = (await this.requireSource(provider).list(cwd, request.controller.signal))
        .map((session) => normalizeMetadata(session, provider, cwd))
        .filter((session): session is ProviderSessionMetadata => session !== null);
      if (this.disposed) return [];
      for (const session of sessions) this.cache(session);
      return sessions.map((session) => ({ ...session }));
    } finally {
      request.close();
    }
  }

  async get(
    provider: ProviderSessionKind,
    sessionId: string,
    cwd: string,
    signal?: AbortSignal
  ): Promise<ProviderSessionMetadata | null> {
    const request = this.beginRequest(signal);
    try {
      const canonicalSessionId = normalizeCanonicalUuid(sessionId);
      if (canonicalSessionId === null) return null;
      const loaded = await this.requireSource(provider).get(
        canonicalSessionId,
        cwd,
        request.controller.signal
      );
      if (this.disposed) return null;
      const session = loaded === null ? null : normalizeMetadata(loaded, provider, cwd);
      const key = providerMetadataKey(provider, canonicalSessionId);
      if (session) this.cache(session);
      else this.metadata.delete(key);
      return session ? { ...session } : null;
    } finally {
      request.close();
    }
  }

  async refreshMapped(
    mappings: readonly ProviderSessionReference[],
    sessions: readonly LiveSession[]
  ): Promise<void> {
    if (this.disposed) return;
    const liveBySurface = new Map(sessions.map((session) => [session.surfaceId, session] as const));
    const targets = mappings.flatMap((mapping) => {
      const session = liveBySurface.get(mapping.surfaceId);
      const exact =
        session?.workspaceId === mapping.workspaceId &&
        session.paneId === mapping.paneId &&
        session.currentDirectory !== null;
      return exact && session.currentDirectory
        ? [{ mapping, cwd: session.currentDirectory }]
        : [];
    });
    const groups = new Map<
      string,
      { provider: ProviderSessionKind; cwd: string; mappings: ProviderSessionReference[] }
    >();
    for (const target of targets) {
      const key = `${target.mapping.provider}\0${target.cwd}`;
      const group = groups.get(key) ?? {
        provider: target.mapping.provider,
        cwd: target.cwd,
        mappings: []
      };
      group.mappings.push(target.mapping);
      groups.set(key, group);
    }
    const groupedTargets = [...groups.values()];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (!this.disposed && cursor < groupedTargets.length) {
        const group = groupedTargets[cursor++];
        if (!group) return;
        let listedIds = new Set<string>();
        try {
          const listed = await this.list(group.provider, group.cwd);
          listedIds = new Set(listed.map((session) => session.sessionId));
        } catch {
          // Exact metadata reads below can still work when list discovery is unavailable.
        }
        for (const mapping of group.mappings) {
          const canonicalSessionId = normalizeCanonicalUuid(mapping.providerSessionId);
          if (canonicalSessionId !== null && !listedIds.has(canonicalSessionId)) {
            try {
              await this.get(mapping.provider, canonicalSessionId, group.cwd);
            } catch {
              // A transient provider metadata failure must not break cmux discovery or erase a known title.
            }
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(METADATA_CONCURRENCY, groupedTargets.length) }, () => worker())
    );
  }

  forget(provider: ProviderSessionKind, sessionId: string): void {
    this.metadata.delete(providerMetadataKey(provider, sessionId));
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    for (const source of this.sources.values()) source.dispose();
    this.metadata.clear();
  }

  private beginRequest(externalSignal?: AbortSignal): {
    controller: AbortController;
    close(): void;
  } {
    if (this.disposed) throw new Error("Provider metadata service has been disposed.");
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = (): void => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", abort, { once: true });
    return {
      controller,
      close: () => {
        externalSignal?.removeEventListener("abort", abort);
        this.controllers.delete(controller);
      }
    };
  }

  private requireSource(provider: ProviderSessionKind): ProviderSessionSource {
    const source = this.sources.get(provider);
    if (!source) throw new Error(`${provider} metadata is not available.`);
    return source;
  }

  private cache(session: ProviderSessionMetadata): void {
    const key = providerMetadataKey(session.provider, session.sessionId);
    this.metadata.delete(key);
    this.metadata.set(key, { ...session });
    while (this.metadata.size > MAX_METADATA_ENTRIES) {
      const oldest = this.metadata.keys().next();
      if (oldest.done) break;
      this.metadata.delete(oldest.value);
    }
  }
}

export function providerMetadataKey(provider: ProviderSessionKind, sessionId: string): string {
  return `${provider}:${normalizeCanonicalUuid(sessionId) ?? sessionId}`;
}

function normalizeMetadata(
  session: ProviderSessionMetadata,
  provider: ProviderSessionKind,
  cwd: string
): ProviderSessionMetadata | null {
  const sessionId = normalizeCanonicalUuid(session.sessionId);
  if (sessionId === null || session.provider !== provider || session.cwd !== cwd) return null;
  return { ...session, sessionId };
}
