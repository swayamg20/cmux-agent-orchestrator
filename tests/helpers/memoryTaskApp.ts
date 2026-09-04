import { TFile, TFolder, type App } from "obsidian";

export interface MemoryTaskAppOptions {
  failFrontmatterWrites?: number;
  failFrontmatterWritesAfterMutation?: number;
  failCreatesAfterMutation?: number;
  beforeCreate?: () => Promise<void>;
  beforeCreateFolder?: (path: string) => Promise<void>;
  beforeFrontmatter?: () => Promise<void>;
  beforeLookup?: (path: string) => void;
  metadataVisible?: (file: TFile) => boolean;
  removeAfterCreate?: boolean;
}

export interface MemoryTaskApp {
  app: App;
  createdFolderPaths: string[];
  markdownWrites: string[];
  createdPaths: string[];
  frontmatterWriteAttempts: () => number;
  replaceFrontmatter(path: string, value: Record<string, unknown>): void;
  replaceFile(path: string, frontmatter?: Record<string, unknown>): TFile;
}

/**
 * A deliberately isolated Obsidian vault double for task-repository tests.
 * It records Markdown in memory and never reads or writes a real vault.
 */
export function createMemoryTaskApp(options: MemoryTaskAppOptions = {}): MemoryTaskApp {
  const entries = new Map<string, TFile | TFolder>();
  const cachedFrontmatter = new Map<TFile, Record<string, unknown>>();
  const markdownByFile = new Map<TFile, string>();
  const markdownWrites: string[] = [];
  const createdPaths: string[] = [];
  const createdFolderPaths: string[] = [];
  let createAttempts = 0;
  let frontmatterWriteAttempts = 0;
  const line = (markdown: string, key: string): string => {
    const match = markdown.match(new RegExp(`^${key}: (.+)$`, "m"));
    if (!match?.[1]) throw new Error(`Missing ${key} in task fixture.`);
    return match[1];
  };
  const jsonLine = (markdown: string, key: string): unknown => JSON.parse(line(markdown, key));
  const createFolder = async (path: string): Promise<void> => {
    await options.beforeCreateFolder?.(path);
    createdFolderPaths.push(path);
    const created = Object.assign(new TFolder(), { path, children: [] as Array<TFile | TFolder> });
    entries.set(path, created);
    const parent = entries.get(path.split("/").slice(0, -1).join("/"));
    if (parent instanceof TFolder) parent.children.push(created);
  };
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => {
        options.beforeLookup?.(path);
        return entries.get(path) ?? null;
      },
      createFolder,
      create: async (path: string, markdown: string) => {
        createAttempts += 1;
        await options.beforeCreate?.();
        createdPaths.push(path);
        markdownWrites.push(markdown);
        const name = path.split("/").pop() ?? path;
        const created = Object.assign(new TFile(), {
          path,
          extension: "md",
          basename: name.replace(/\.md$/, ""),
          stat: { ctime: Date.now(), mtime: Date.now() }
        });
        entries.set(path, created);
        markdownByFile.set(created, markdown);
        const parent = entries.get(path.split("/").slice(0, -1).join("/"));
        if (parent instanceof TFolder) parent.children.push(created);
        cachedFrontmatter.set(created, {
          "agent-cockpit": "task",
          "schema-version": 1,
          "task-id": jsonLine(markdown, "task-id"),
          title: jsonLine(markdown, "title"),
          "workflow-status": line(markdown, "workflow-status"),
          priority: line(markdown, "priority"),
          repository: jsonLine(markdown, "repository"),
          branch: jsonLine(markdown, "branch"),
          worktree: jsonLine(markdown, "worktree"),
          "run-count": Number(line(markdown, "run-count")),
          "created-at": jsonLine(markdown, "created-at"),
          "updated-at": jsonLine(markdown, "updated-at")
        });
        if (options.removeAfterCreate) {
          queueMicrotask(() => {
            entries.delete(path);
            const index = parent instanceof TFolder ? parent.children.indexOf(created) : -1;
            if (parent instanceof TFolder && index >= 0) parent.children.splice(index, 1);
          });
        }
        if (createAttempts <= (options.failCreatesAfterMutation ?? 0)) {
          throw new Error("simulated post-create vault failure");
        }
        return created;
      },
      read: async (file: TFile) => markdownByFile.get(file) ?? ""
    },
    metadataCache: {
      getFileCache: (file: TFile) => {
        if (options.metadataVisible?.(file) === false) return null;
        const frontmatter = cachedFrontmatter.get(file);
        return frontmatter === undefined ? null : { frontmatter };
      }
    },
    fileManager: {
      processFrontMatter: async (
        file: TFile,
        update: (frontmatter: Record<string, unknown>) => void
      ) => {
        frontmatterWriteAttempts += 1;
        await options.beforeFrontmatter?.();
        if (frontmatterWriteAttempts <= (options.failFrontmatterWrites ?? 0)) {
          throw new Error("simulated task frontmatter write failure");
        }
        const frontmatter = cachedFrontmatter.get(file);
        if (!frontmatter) throw new Error("Missing task frontmatter fixture.");
        update(frontmatter);
        if (frontmatterWriteAttempts <= (options.failFrontmatterWritesAfterMutation ?? 0)) {
          throw new Error("simulated post-mutation frontmatter write failure");
        }
      }
    }
  } as unknown as App;
  return {
    app,
    createdFolderPaths,
    markdownWrites,
    createdPaths,
    frontmatterWriteAttempts: () => frontmatterWriteAttempts,
    replaceFrontmatter: (path, value) => {
      const entry = entries.get(path);
      if (!(entry instanceof TFile)) throw new Error(`Missing task fixture at ${path}.`);
      cachedFrontmatter.set(entry, value);
    },
    replaceFile: (path, frontmatter) => {
      const previous = entries.get(path);
      if (!(previous instanceof TFile)) throw new Error(`Missing task fixture at ${path}.`);
      const parent = entries.get(path.split("/").slice(0, -1).join("/"));
      if (parent instanceof TFolder) {
        const index = parent.children.indexOf(previous);
        if (index >= 0) parent.children.splice(index, 1);
      }
      cachedFrontmatter.delete(previous);
      markdownByFile.delete(previous);
      const name = path.split("/").pop() ?? path;
      const replacement = Object.assign(new TFile(), {
        path,
        extension: "md",
        basename: name.replace(/\.md$/, ""),
        stat: { ctime: Date.now(), mtime: Date.now() }
      });
      entries.set(path, replacement);
      if (parent instanceof TFolder) parent.children.push(replacement);
      if (frontmatter !== undefined) cachedFrontmatter.set(replacement, frontmatter);
      return replacement;
    }
  };
}
