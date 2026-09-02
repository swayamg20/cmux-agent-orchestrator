import { homedir } from "node:os";
import path from "node:path";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { isCanonicalUuid } from "../security/identifiers";
import { sanitizeProviderTitle } from "./titleSanitizer";
import {
  ProviderMetadataError,
  type ProviderSessionMetadata,
  type ProviderSessionSource,
  type ProviderTitleSource
} from "./types";

const MAX_ACTIVE_SESSION_FILES = 200;
const MAX_SESSION_FILE_BYTES = 64 * 1024;
const TITLE_EDGE_BYTES = 128 * 1024;

interface ClaudeTitleMetadata {
  title: string;
  titleSource: "explicit-name" | "ai-title";
  updatedAt: number | null;
}

export class ClaudeSessionSource implements ProviderSessionSource {
  readonly provider = "claude" as const;

  constructor(private readonly claudeRoot = path.join(homedir(), ".claude")) {}

  async list(cwd: string, signal?: AbortSignal): Promise<ProviderSessionMetadata[]> {
    assertAbsoluteCwd(cwd);
    const seeds = await this.readActiveSessions(cwd, signal);
    const sessions: ProviderSessionMetadata[] = [];
    for (const seed of seeds) {
      throwIfAborted(signal);
      sessions.push(await this.enrich(seed, signal));
    }
    return sessions.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  }

  async get(sessionId: string, cwd: string, signal?: AbortSignal): Promise<ProviderSessionMetadata | null> {
    assertProviderSessionId(sessionId);
    assertAbsoluteCwd(cwd);
    const active = (await this.readActiveSessions(cwd, signal)).find(
      (session) => session.sessionId === sessionId
    );
    if (active) return this.enrich(active, signal);

    const title = await this.readTitle(sessionId, cwd, signal);
    if (!title) return null;
    return {
      provider: "claude",
      sessionId,
      title: title.title,
      titleSource: title.titleSource,
      cwd,
      updatedAt: title.updatedAt,
      status: null
    };
  }

  dispose(): void {
    // Reads are bounded and do not keep a long-lived provider process open.
  }

  private async readActiveSessions(
    cwd: string,
    signal?: AbortSignal
  ): Promise<ProviderSessionMetadata[]> {
    const directory = path.join(this.claudeRoot, "sessions");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw new ProviderMetadataError("Claude session metadata is unavailable.", error);
    }

    const sessions: ProviderSessionMetadata[] = [];
    for (const entry of entries.slice(0, MAX_ACTIVE_SESSION_FILES)) {
      throwIfAborted(signal);
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filename = path.join(directory, entry.name);
      try {
        const details = await stat(filename);
        if (!details.isFile() || details.size > MAX_SESSION_FILE_BYTES) continue;
        const content = await readFile(filename, { encoding: "utf8", signal });
        const decoded = decodeClaudeSession(JSON.parse(content) as unknown, cwd, details.mtimeMs);
        if (decoded) sessions.push(decoded);
      } catch (error) {
        if (isAbort(error)) throw error;
        // One stale or malformed provider registry file must not hide healthy sessions.
      }
    }
    return sessions;
  }

  private async enrich(
    session: ProviderSessionMetadata,
    signal?: AbortSignal
  ): Promise<ProviderSessionMetadata> {
    const title = await this.readTitle(session.sessionId, session.cwd, signal);
    if (!title) return session;
    const registryIsExplicit = session.titleSource === "explicit-name";
    const transcriptIsExplicit = title.titleSource === "explicit-name";
    const selected = transcriptIsExplicit || !registryIsExplicit ? title : session;
    return {
      ...session,
      title: selected.title,
      titleSource: selected.titleSource,
      updatedAt: Math.max(session.updatedAt ?? 0, title.updatedAt ?? 0) || null
    };
  }

  private async readTitle(
    sessionId: string,
    cwd: string,
    signal?: AbortSignal
  ): Promise<ClaudeTitleMetadata | null> {
    const projectDirectory = claudeProjectDirectory(this.claudeRoot, cwd);
    const filename = path.join(projectDirectory, `${sessionId}.jsonl`);
    try {
      const details = await stat(filename);
      if (!details.isFile()) return null;
      const content = await readBoundedEdges(filename, details.size, signal);
      const title = decodeClaudeTitleRecords(content, sessionId);
      return title ? { ...title, updatedAt: details.mtimeMs } : null;
    } catch (error) {
      if (isAbort(error)) throw error;
      return null;
    }
  }
}

export function decodeClaudeSession(
  value: unknown,
  cwd: string,
  fileUpdatedAt: number | null = null
): ProviderSessionMetadata | null {
  const raw = record(value);
  if (!raw || typeof raw.sessionId !== "string" || !isCanonicalUuid(raw.sessionId) || raw.cwd !== cwd) {
    return null;
  }
  const name = sanitizeProviderTitle(raw.name);
  const fallback = `Claude conversation ${raw.sessionId.slice(0, 8)}`;
  const titleSource: ProviderTitleSource = name
    ? isExplicitNameSource(raw.nameSource)
      ? "explicit-name"
      : "session-name"
    : "session-id";
  const timestamps = [raw.lastActivityAt, raw.startedAt, fileUpdatedAt].filter(
    (candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
  );
  return {
    provider: "claude",
    sessionId: raw.sessionId,
    title: name ?? fallback,
    titleSource,
    cwd,
    updatedAt: timestamps.length > 0 ? Math.max(...timestamps) : null,
    status: sanitizeProviderTitle(raw.status)
  };
}

export function decodeClaudeTitleRecords(
  content: string,
  sessionId: string
): Pick<ClaudeTitleMetadata, "title" | "titleSource"> | null {
  assertProviderSessionId(sessionId);
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    if (!/"type"\s*:\s*"(?:ai-title|custom-title)"/.test(line)) continue;
    try {
      const raw = record(JSON.parse(line) as unknown);
      if (!raw || raw.sessionId !== sessionId) continue;
      if (raw.type === "custom-title") {
        customTitle = sanitizeProviderTitle(raw.customTitle) ?? customTitle;
      } else if (raw.type === "ai-title") {
        aiTitle = sanitizeProviderTitle(raw.aiTitle) ?? aiTitle;
      }
    } catch {
      // Edge chunks may begin or end in the middle of a JSONL record.
    }
  }
  if (customTitle) return { title: customTitle, titleSource: "explicit-name" };
  if (aiTitle) return { title: aiTitle, titleSource: "ai-title" };
  return null;
}

export function claudeProjectDirectory(claudeRoot: string, cwd: string): string {
  assertAbsoluteCwd(cwd);
  const encoded = cwd.replaceAll("/", "-");
  return path.join(claudeRoot, "projects", encoded);
}

async function readBoundedEdges(
  filename: string,
  size: number,
  signal?: AbortSignal
): Promise<string> {
  throwIfAborted(signal);
  const handle = await open(filename, "r");
  try {
    if (size <= TITLE_EDGE_BYTES * 2) {
      const buffer = Buffer.alloc(Math.max(0, size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      throwIfAborted(signal);
      return buffer.subarray(0, bytesRead).toString("utf8");
    }
    const start = Buffer.alloc(TITLE_EDGE_BYTES);
    const end = Buffer.alloc(TITLE_EDGE_BYTES);
    const first = await handle.read(start, 0, start.length, 0);
    throwIfAborted(signal);
    const last = await handle.read(end, 0, end.length, size - TITLE_EDGE_BYTES);
    throwIfAborted(signal);
    return `${start.subarray(0, first.bytesRead).toString("utf8")}\n${end
      .subarray(0, last.bytesRead)
      .toString("utf8")}`;
  } finally {
    await handle.close();
  }
}

function isExplicitNameSource(value: unknown): boolean {
  return value === "user" || value === "custom" || value === "manual";
}

function assertAbsoluteCwd(cwd: string): void {
  if (!path.isAbsolute(cwd) || cwd.includes("\0") || cwd.length > 4_096) {
    throw new ProviderMetadataError("Provider metadata requires a bounded absolute working directory.");
  }
}

function assertProviderSessionId(sessionId: string): void {
  if (!isCanonicalUuid(sessionId)) {
    throw new ProviderMetadataError("Provider conversation ID is not a canonical UUID.");
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function isMissing(error: unknown): boolean {
  return record(error)?.code === "ENOENT";
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("Claude metadata request was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}
