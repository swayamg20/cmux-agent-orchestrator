import { createHash } from "node:crypto";
import { posix } from "node:path";
import { normalizePath, parseYaml } from "obsidian";

export const REPOSITORY_LINK_PROPERTY = "repository-note";
export const REPOSITORY_NOTE_MARKER = "cmux-agent-orchestrator";
export const REPOSITORY_NOTE_SCHEMA_VERSION = 1;

export interface RepositoryGraphTarget {
  repository: string;
  repositoryId: string;
  title: string;
  folderPath: string;
  filePath: string;
  link: string;
}

const MAX_REPOSITORY_NOTE_CHARACTERS = 16_384;

export function repositoryGraphTarget(
  taskFolder: string,
  repository: string | null
): RepositoryGraphTarget | null {
  const normalizedRepository = normalizeRepositoryIdentity(repository);
  if (normalizedRepository === null) return null;

  const repositoryId = createHash("sha256")
    .update(normalizedRepository, "utf8")
    .digest("hex");
  const title = repositoryTitle(normalizedRepository);
  const folderPath = repositoryHubFolder(taskFolder);
  const fileStem = `${repositorySlug(title)}-${repositoryId.slice(0, 12)}`;
  const filePath = normalizePath(`${folderPath}/${fileStem}.md`);
  const linkPath = filePath.slice(0, -3);

  return {
    repository: normalizedRepository,
    repositoryId,
    title,
    folderPath,
    filePath,
    link: `[[${linkPath}|${repositoryAlias(title)}]]`
  };
}

export function repositoryHubFolder(taskFolder: string): string {
  const normalizedTaskFolder = normalizePath(taskFolder);
  const separator = normalizedTaskFolder.lastIndexOf("/");
  const parent = separator < 0 ? "" : normalizedTaskFolder.slice(0, separator);
  const candidate = normalizePath(parent ? `${parent}/Repositories` : "Repositories");
  return candidate === normalizedTaskFolder
    ? normalizePath(parent ? `${parent}/Repository Hubs` : "Repository Hubs")
    : candidate;
}

export function normalizeRepositoryIdentity(repository: string | null): string | null {
  if (repository === null) return null;
  const cleaned = repository.replace(/[\r\n\0]+/g, " ").trim().replace(/\\/g, "/");
  if (!cleaned) return null;

  const normalized = posix.normalize(cleaned);
  if (!normalized || normalized === ".") return null;
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "") || null;
}

export function createRepositoryHubMarkdown(target: RepositoryGraphTarget): string {
  return `---
${REPOSITORY_NOTE_MARKER}: repository
schema-version: ${String(REPOSITORY_NOTE_SCHEMA_VERSION)}
repository-id: ${JSON.stringify(target.repositoryId)}
title: ${JSON.stringify(target.title)}
repository: ${JSON.stringify(target.repository)}
---

# ${escapeMarkdownHeading(target.title)}

Tasks linking to this managed note belong to the same repository.
`;
}

export function repositoryHubFrontmatterMatches(
  frontmatter: unknown,
  target: RepositoryGraphTarget
): boolean {
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    return false;
  }
  const raw = frontmatter as Record<string, unknown>;
  return raw[REPOSITORY_NOTE_MARKER] === "repository" &&
    raw["schema-version"] === REPOSITORY_NOTE_SCHEMA_VERSION &&
    raw["repository-id"] === target.repositoryId &&
    normalizeRepositoryIdentity(
      typeof raw.repository === "string" ? raw.repository : null
    ) === target.repository;
}

export function repositoryHubMarkdownMatches(
  markdown: string,
  target: RepositoryGraphTarget
): boolean {
  if (markdown.length > MAX_REPOSITORY_NOTE_CHARACTERS) return false;
  const firstLineEnd = markdown.indexOf("\n");
  if (firstLineEnd < 0 || markdown.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") {
    return false;
  }
  const closingFence = /^---[ \t]*\r?$/gm;
  closingFence.lastIndex = firstLineEnd + 1;
  const closingMatch = closingFence.exec(markdown);
  if (closingMatch === null) return false;
  const frontmatter = markdown.slice(firstLineEnd + 1, closingMatch.index);
  if (
    [REPOSITORY_NOTE_MARKER, "schema-version", "repository-id", "repository"]
      .some((key) => frontmatterKeyCount(frontmatter, key) !== 1)
  ) {
    return false;
  }
  try {
    return repositoryHubFrontmatterMatches(
      parseYaml(frontmatter),
      target
    );
  } catch {
    return false;
  }
}

function repositoryTitle(repository: string): string {
  const withoutTrailingSeparators = repository.replace(/\/+$/, "");
  const basename = withoutTrailingSeparators.split("/").pop()?.trim() ?? "";
  return sanitizeDisplayText(basename.replace(/\.git$/i, "")) || "Repository";
}

function repositorySlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "repository";
}

function repositoryAlias(value: string): string {
  return sanitizeDisplayText(
    value.replaceAll("[", " ").replaceAll("]", " ").replace(/[\\|#^]+/g, " ")
  ) || "Repository";
}

function sanitizeDisplayText(value: string): string {
  return value
    .replace(/[\r\n\0]+/g, " ")
    .replace(/[<>]+/g, " ")
    .replace(/^#+\s*/, "")
    .trim()
    .slice(0, 128);
}

function escapeMarkdownHeading(value: string): string {
  return value.replace(/([\\`*_[\]{}()#+.!|~-])/g, "\\$1");
}

function frontmatterKeyCount(frontmatter: string, key: string): number {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...frontmatter.matchAll(new RegExp(`^(?:${escapedKey}|"${escapedKey}"|'${escapedKey}')[ \\t]*:`, "gm"))].length;
}
