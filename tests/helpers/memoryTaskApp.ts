import { TFile, TFolder, type App } from "obsidian";
import { parse as parseYamlDocument } from "yaml";

export interface MemoryTaskAppOptions {
  failFrontmatterWrites?: number;
  failFrontmatterWritesAfterMutation?: number;
  failCreatesAfterMutation?: number;
  failCreateAttemptsAfterMutation?: readonly number[];
  afterCreateMutation?: (path: string, file: TFile) => Promise<void>;
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
  repositoryHubMarkdownWrites: string[];
  repositoryHubPaths: string[];
  frontmatterWriteAttempts: () => number;
  frontmatterAt(path: string): Record<string, unknown> | null;
  markdownAt(path: string): string | null;
  replaceFrontmatter(path: string, value: Record<string, unknown>): void;
  replaceMarkdown(path: string, markdown: string): void;
  replaceFile(path: string, frontmatter?: Record<string, unknown>): TFile;
  renameFile(oldPath: string, newPath: string): TFile;
  renameFolder(oldPath: string, newPath: string): TFolder;
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
  const repositoryHubMarkdownWrites: string[] = [];
  const repositoryHubPaths: string[] = [];
  const createdFolderPaths: string[] = [];
  let createAttempts = 0;
  let frontmatterWriteAttempts = 0;
  const createFolder = async (path: string): Promise<void> => {
    await options.beforeCreateFolder?.(path);
    createdFolderPaths.push(path);
    const parent = entries.get(path.split("/").slice(0, -1).join("/"));
    const created = Object.assign(new TFolder(), {
      path,
      name: path.split("/").pop() ?? path,
      parent: parent instanceof TFolder ? parent : null,
      children: [] as Array<TFile | TFolder>
    });
    entries.set(path, created);
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
        const frontmatter = markdownFrontmatter(markdown);
        const isTask = frontmatter["agent-cockpit"] === "task";
        if (isTask) {
          createAttempts += 1;
          await options.beforeCreate?.();
          createdPaths.push(path);
          markdownWrites.push(markdown);
        } else {
          repositoryHubPaths.push(path);
          repositoryHubMarkdownWrites.push(markdown);
        }
        const name = path.split("/").pop() ?? path;
        const parent = entries.get(path.split("/").slice(0, -1).join("/"));
        const created = Object.assign(new TFile(), {
          path,
          name,
          extension: "md",
          basename: name.replace(/\.md$/, ""),
          parent: parent instanceof TFolder ? parent : null,
          stat: { ctime: Date.now(), mtime: Date.now() }
        });
        entries.set(path, created);
        markdownByFile.set(created, markdown);
        if (parent instanceof TFolder) parent.children.push(created);
        cachedFrontmatter.set(created, frontmatter);
        if (isTask) await options.afterCreateMutation?.(path, created);
        if (isTask && options.removeAfterCreate) {
          queueMicrotask(() => {
            entries.delete(path);
            const index = parent instanceof TFolder ? parent.children.indexOf(created) : -1;
            if (parent instanceof TFolder && index >= 0) parent.children.splice(index, 1);
          });
        }
        if (isTask && (
          createAttempts <= (options.failCreatesAfterMutation ?? 0) ||
          options.failCreateAttemptsAfterMutation?.includes(createAttempts) === true
        )) {
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
    repositoryHubMarkdownWrites,
    repositoryHubPaths,
    frontmatterWriteAttempts: () => frontmatterWriteAttempts,
    frontmatterAt: (path) => {
      const entry = entries.get(path);
      if (!(entry instanceof TFile)) return null;
      return cachedFrontmatter.get(entry) ?? null;
    },
    markdownAt: (path) => {
      const entry = entries.get(path);
      if (!(entry instanceof TFile)) return null;
      return markdownByFile.get(entry) ?? null;
    },
    replaceFrontmatter: (path, value) => {
      const entry = entries.get(path);
      if (!(entry instanceof TFile)) throw new Error(`Missing task fixture at ${path}.`);
      cachedFrontmatter.set(entry, value);
    },
    replaceMarkdown: (path, markdown) => {
      const entry = entries.get(path);
      if (!(entry instanceof TFile)) throw new Error(`Missing task fixture at ${path}.`);
      markdownByFile.set(entry, markdown);
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
        name,
        extension: "md",
        basename: name.replace(/\.md$/, ""),
        parent: parent instanceof TFolder ? parent : null,
        stat: { ctime: Date.now(), mtime: Date.now() }
      });
      entries.set(path, replacement);
      if (parent instanceof TFolder) parent.children.push(replacement);
      if (frontmatter !== undefined) cachedFrontmatter.set(replacement, frontmatter);
      return replacement;
    },
    renameFile: (oldPath, newPath) => {
      const file = entries.get(oldPath);
      if (!(file instanceof TFile)) throw new Error(`Missing task fixture at ${oldPath}.`);
      if (entries.has(newPath)) throw new Error(`Task fixture already exists at ${newPath}.`);
      const oldParentPath = oldPath.split("/").slice(0, -1).join("/");
      const newParentPath = newPath.split("/").slice(0, -1).join("/");
      const oldParent = entries.get(oldParentPath);
      const newParent = entries.get(newParentPath);
      if (!(newParent instanceof TFolder)) {
        throw new Error(`Missing task fixture folder at ${newParentPath}.`);
      }
      if (oldParent !== newParent) {
        if (oldParent instanceof TFolder) {
          const index = oldParent.children.indexOf(file);
          if (index >= 0) oldParent.children.splice(index, 1);
        }
        newParent.children.push(file);
      }
      const name = newPath.split("/").pop() ?? newPath;
      entries.delete(oldPath);
      Object.assign(file, {
        path: newPath,
        name,
        basename: name.replace(/\.[^.]+$/, ""),
        extension: name.includes(".") ? name.split(".").pop() ?? "" : "",
        parent: newParent
      });
      entries.set(newPath, file);
      return file;
    },
    renameFolder: (oldPath, newPath) => {
      const renamedFolder = entries.get(oldPath);
      if (!(renamedFolder instanceof TFolder)) {
        throw new Error(`Missing task fixture folder at ${oldPath}.`);
      }
      if (entries.has(newPath)) throw new Error(`Task fixture already exists at ${newPath}.`);
      const oldParentPath = oldPath.split("/").slice(0, -1).join("/");
      const newParentPath = newPath.split("/").slice(0, -1).join("/");
      const oldParent = entries.get(oldParentPath);
      const newParent = entries.get(newParentPath);
      if (!(newParent instanceof TFolder)) {
        throw new Error(`Missing task fixture folder at ${newParentPath}.`);
      }
      if (oldParent !== newParent) {
        if (oldParent instanceof TFolder) {
          const index = oldParent.children.indexOf(renamedFolder);
          if (index >= 0) oldParent.children.splice(index, 1);
        }
        newParent.children.push(renamedFolder);
      }
      const movedEntries = [...entries]
        .filter(([path]) => path === oldPath || path.startsWith(`${oldPath}/`));
      for (const [path] of movedEntries) entries.delete(path);
      for (const [path, entry] of movedEntries) {
        const movedPath = `${newPath}${path.slice(oldPath.length)}`;
        const name = movedPath.split("/").pop() ?? movedPath;
        const attributes: Record<string, unknown> = {
          path: movedPath,
          name
        };
        if (entry === renamedFolder) attributes.parent = newParent;
        if (entry instanceof TFile) {
          attributes.basename = name.replace(/\.[^.]+$/, "");
          attributes.extension = name.includes(".") ? name.split(".").pop() ?? "" : "";
        }
        Object.assign(entry, attributes);
        entries.set(movedPath, entry);
      }
      return renamedFolder;
    }
  };
}

function markdownFrontmatter(markdown: string): Record<string, unknown> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (match?.[1] === undefined) throw new Error("Missing frontmatter in task fixture.");
  const parsed: unknown = parseYamlDocument(match[1]) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid frontmatter in task fixture.");
  }
  return parsed as Record<string, unknown>;
}
