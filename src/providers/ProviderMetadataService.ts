import type { LiveSession } from "../state/types";
import { canonicalUuidEquals, normalizeCanonicalUuid } from "../security/identifiers";
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
const MAX_REQUEST_REVISIONS = 2_000;

interface ExactRequestResult {
  revision: number;
  promise: Promise<ProviderSessionMetadata | null>;
  resolve(value: ProviderSessionMetadata | null): void;
}

export class ProviderMetadataService {
  private readonly sources: ReadonlyMap<ProviderSessionKind, ProviderSessionSource>;
  private readonly metadata = new Map<string, ProviderSessionMetadata>();
  private readonly requestRevisions = new Map<string, number>();
  private readonly exactSourceRevisions = new Map<string, number>();
  private readonly exactRequestResults = new Map<string, ExactRequestResult>();
  private readonly sharedListRequests = new Map<
    string,
    Promise<ProviderSessionMetadata[]>
  >();
  private readonly controllers = new Set<AbortController>();
  private requestSequence = 0;
  private retiredThrough = 0;
  private exactSourceRetiredThrough = 0;
  private disposed = false;

  constructor(
    sources: readonly ProviderSessionSource[] = [new ClaudeSessionSource(), new CodexAppServerSource()]
  ) {
    this.sources = new Map(sources.map((source) => [source.provider, source]));
  }

  get evidence(): ReadonlyMap<string, ProviderSessionMetadata> {
    return this.metadata;
  }

  supports(provider: ProviderSessionKind): boolean {
    return this.sources.has(provider);
  }

  async list(
    provider: ProviderSessionKind,
    cwd: string,
    signal?: AbortSignal
  ): Promise<ProviderSessionMetadata[]> {
    if (signal !== undefined) return this.loadList(provider, cwd, signal);
    const listKey = providerMetadataListKey(provider, cwd);
    const existing = this.sharedListRequests.get(listKey);
    if (existing !== undefined) return cloneMetadataList(await existing);

    const request = this.loadList(provider, cwd);
    this.sharedListRequests.set(listKey, request);
    try {
      return cloneMetadataList(await request);
    } finally {
      if (this.sharedListRequests.get(listKey) === request) {
        this.sharedListRequests.delete(listKey);
      }
    }
  }

  private async loadList(
    provider: ProviderSessionKind,
    cwd: string,
    signal?: AbortSignal
  ): Promise<ProviderSessionMetadata[]> {
    const request = this.beginRequest(signal);
    const listKey = providerMetadataListKey(provider, cwd);
    this.markRequest(listKey, request.revision);
    try {
      const sessions = (await this.requireSource(provider).list(cwd, request.controller.signal))
        .map((session) => normalizeMetadata(session, provider, cwd))
        .filter((session): session is ProviderSessionMetadata => session !== null);
      if (
        this.disposed ||
        request.controller.signal.aborted ||
        !this.isLatestRequest(listKey, request.revision)
      ) {
        return [];
      }
      const current: ProviderSessionMetadata[] = [];
      for (const session of sessions) {
        this.cache(session, request.revision);
        const key = providerMetadataKey(session.provider, session.sessionId);
        if (this.isLatestRequest(key, request.revision)) {
          this.beginExactRequestResult(key, request.revision).resolve(session);
          current.push(session);
        }
      }
      return current.map((session) => ({ ...session }));
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
      const key = providerMetadataKey(provider, canonicalSessionId);
      this.markRequest(key, request.revision);
      this.markExactSourceRequest(key, request.revision);
      const published = this.beginExactRequestResult(key, request.revision);
      try {
        const loaded = await this.requireSource(provider).get(
          canonicalSessionId,
          cwd,
          request.controller.signal
        );
        if (this.disposed || request.controller.signal.aborted) {
          published.resolve(null);
          return null;
        }
        const session = normalizeExactMetadata(
          loaded,
          provider,
          canonicalSessionId,
          cwd
        );
        if (!this.isLatestRequest(key, request.revision)) {
          const latest = this.exactRequestResults.get(key);
          const replacement = latest !== undefined && latest.revision > request.revision
            ? await latest.promise
            : null;
          if (this.disposed || request.controller.signal.aborted) {
            published.resolve(null);
            return null;
          }
          const result = normalizeExactMetadata(
            replacement,
            provider,
            canonicalSessionId,
            cwd
          );
          published.resolve(result);
          return result === null ? null : { ...result };
        }
        if (session) this.cache(session, request.revision);
        else this.metadata.delete(key);
        const result = session ? { ...session } : null;
        published.resolve(result);
        return result;
      } catch (error) {
        published.resolve(null);
        throw error;
      }
    } finally {
      request.close();
    }
  }

  /**
   * Reads the exact provider record without allowing bounded browse-list metadata to
   * substitute for the source response. Intended for validation before durable writes.
   */
  async verifyExact(
    provider: ProviderSessionKind,
    sessionId: string,
    cwd: string,
    signal?: AbortSignal
  ): Promise<ProviderSessionMetadata | null> {
    const request = this.beginRequest(signal);
    try {
      const canonicalSessionId = normalizeCanonicalUuid(sessionId);
      if (canonicalSessionId === null) return null;
      const key = providerMetadataKey(provider, canonicalSessionId);
      this.markRequest(key, request.revision);
      this.markExactSourceRequest(key, request.revision);
      const loaded = await this.requireSource(provider).get(
        canonicalSessionId,
        cwd,
        request.controller.signal
      );
      if (this.disposed || request.controller.signal.aborted) return null;
      const session = normalizeExactMetadata(loaded, provider, canonicalSessionId, cwd);
      if (!this.isLatestExactSourceRequest(key, request.revision)) return null;

      if (this.isLatestRequest(key, request.revision)) {
        if (session) this.cache(session, request.revision);
        else this.metadata.delete(key);
        this.beginExactRequestResult(key, request.revision).resolve(session);
      }
      return session === null ? null : { ...session };
    } finally {
      request.close();
    }
  }

  async refreshMapped(
    mappings: readonly ProviderSessionReference[],
    sessions: readonly LiveSession[]
  ): Promise<void> {
    if (this.disposed) return;
    const liveBySurface = new Map(
      sessions.map((session) => [normalizeCanonicalUuid(session.surfaceId) ?? session.surfaceId, session] as const)
    );
    const targets = mappings.flatMap((mapping) => {
      const surfaceId = normalizeCanonicalUuid(mapping.surfaceId);
      if (surfaceId === null) return [];
      const session = liveBySurface.get(surfaceId);
      if (!session) return [];
      const exact =
        canonicalUuidEquals(session.workspaceId, mapping.workspaceId) &&
        canonicalUuidEquals(session.paneId, mapping.paneId) &&
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
    if (this.disposed) return;
    const key = providerMetadataKey(provider, sessionId);
    const revision = ++this.requestSequence;
    this.markRequest(key, revision);
    this.markExactSourceRequest(key, revision);
    this.beginExactRequestResult(key, revision).resolve(null);
    this.metadata.delete(key);
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    for (const result of this.exactRequestResults.values()) result.resolve(null);
    this.exactRequestResults.clear();
    this.sharedListRequests.clear();
    for (const source of this.sources.values()) source.dispose();
    this.metadata.clear();
    this.requestRevisions.clear();
    this.exactSourceRevisions.clear();
  }

  private beginRequest(externalSignal?: AbortSignal): {
    controller: AbortController;
    revision: number;
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
      revision: ++this.requestSequence,
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

  private cache(session: ProviderSessionMetadata, revision: number): void {
    const key = providerMetadataKey(session.provider, session.sessionId);
    if (revision <= this.retiredThrough) return;
    const latest = this.requestRevisions.get(key);
    if (latest !== undefined && revision < latest) return;
    if (!this.markRequest(key, revision)) return;
    this.metadata.delete(key);
    this.metadata.set(key, { ...session });
    while (this.metadata.size > MAX_METADATA_ENTRIES) {
      const oldest = this.metadata.keys().next();
      if (oldest.done) break;
      this.metadata.delete(oldest.value);
    }
  }

  private isLatestRequest(key: string, revision: number): boolean {
    return (
      revision > this.retiredThrough &&
      (this.requestRevisions.get(key) ?? revision) === revision
    );
  }

  private isLatestExactSourceRequest(key: string, revision: number): boolean {
    return (
      revision > this.exactSourceRetiredThrough &&
      (this.exactSourceRevisions.get(key) ?? revision) === revision
    );
  }

  private beginExactRequestResult(key: string, revision: number): ExactRequestResult {
    const previous = this.exactRequestResults.get(key);
    let settle!: (value: ProviderSessionMetadata | null) => void;
    const promise = new Promise<ProviderSessionMetadata | null>((resolve) => {
      settle = resolve;
    });
    let settled = false;
    const result: ExactRequestResult = {
      revision,
      promise,
      resolve: (value) => {
        if (settled) return;
        settled = true;
        settle(value === null ? null : { ...value });
      }
    };
    this.exactRequestResults.delete(key);
    this.exactRequestResults.set(key, result);
    if (previous !== undefined && previous.revision < revision) {
      void result.promise.then(
        (value) => previous.resolve(value),
        () => previous.resolve(null)
      );
    }
    while (this.exactRequestResults.size > MAX_REQUEST_REVISIONS) {
      const oldest = this.exactRequestResults.entries().next();
      if (oldest.done) break;
      const [oldestKey, oldestResult] = oldest.value;
      this.exactRequestResults.delete(oldestKey);
      oldestResult.resolve(null);
    }
    return result;
  }

  private markRequest(key: string, revision: number): boolean {
    if (revision <= this.retiredThrough) return false;
    this.requestRevisions.delete(key);
    this.requestRevisions.set(key, revision);
    while (this.requestRevisions.size > MAX_REQUEST_REVISIONS) {
      const oldest = this.requestRevisions.entries().next();
      if (oldest.done) break;
      const [oldestKey, oldestRevision] = oldest.value;
      this.requestRevisions.delete(oldestKey);
      this.retiredThrough = Math.max(this.retiredThrough, oldestRevision);
    }
    if (revision > this.retiredThrough) return true;
    if (this.requestRevisions.get(key) === revision) this.requestRevisions.delete(key);
    return false;
  }

  private markExactSourceRequest(key: string, revision: number): boolean {
    if (revision <= this.exactSourceRetiredThrough) return false;
    this.exactSourceRevisions.delete(key);
    this.exactSourceRevisions.set(key, revision);
    while (this.exactSourceRevisions.size > MAX_REQUEST_REVISIONS) {
      const oldest = this.exactSourceRevisions.entries().next();
      if (oldest.done) break;
      const [oldestKey, oldestRevision] = oldest.value;
      this.exactSourceRevisions.delete(oldestKey);
      this.exactSourceRetiredThrough = Math.max(
        this.exactSourceRetiredThrough,
        oldestRevision
      );
    }
    if (revision > this.exactSourceRetiredThrough) return true;
    if (this.exactSourceRevisions.get(key) === revision) {
      this.exactSourceRevisions.delete(key);
    }
    return false;
  }
}

export function providerMetadataKey(provider: ProviderSessionKind, sessionId: string): string {
  return `${provider}:${normalizeCanonicalUuid(sessionId) ?? sessionId}`;
}

function providerMetadataListKey(provider: ProviderSessionKind, cwd: string): string {
  return `list:${JSON.stringify([provider, cwd])}`;
}

function cloneMetadataList(sessions: readonly ProviderSessionMetadata[]): ProviderSessionMetadata[] {
  return sessions.map((session) => ({ ...session }));
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

function normalizeExactMetadata(
  session: ProviderSessionMetadata | null,
  provider: ProviderSessionKind,
  sessionId: string,
  cwd: string
): ProviderSessionMetadata | null {
  if (session === null) return null;
  const normalized = normalizeMetadata(session, provider, cwd);
  return normalized?.sessionId === sessionId ? normalized : null;
}
