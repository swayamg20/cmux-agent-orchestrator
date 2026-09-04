import { TFile, TFolder, type App } from "obsidian";

export interface MemoryTaskAppOptions {
  failFrontmatterWrites?: number;
  beforeCreate?: () => Promise<void>;
  removeAfterCreate?: boolean;
}

export interface MemoryTaskApp {
  app: App;
  markdownWrites: string[];
  createdPaths: string[];
}

/**
 * A deliberately isolated Obsidian vault double for task-repository tests.
 * It records Markdown in memory and never reads or writes a real vault.
 */
export function createMemoryTaskApp(options: MemoryTaskAppOptions = {}): MemoryTaskApp {
  const entries = new Map<string, TFile | TFolder>();
  const cachedFrontmatter = new Map<TFile, Record<string, unknown>>();
  const markdownWrites: string[] = [];
  const createdPaths: string[] = [];
  let frontmatterWriteAttempts = 0;
  const line = (markdown: string, key: string): string => {
    const match = markdown.match(new RegExp(`^${key}: (.+)$`, "m"));
    if (!match?.[1]) throw new Error(`Missing ${key} in task fixture.`);
    return match[1];
  };
  const jsonLine = (markdown: string, key: string): unknown => JSON.parse(line(markdown, key));
  const createFolder = async (path: string): Promise<void> => {
    const created = Object.assign(new TFolder(), { path, children: [] as Array<TFile | TFolder> });
    entries.set(path, created);
    const parent = entries.get(path.split("/").slice(0, -1).join("/"));
    if (parent instanceof TFolder) parent.children.push(created);
  };
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
      createFolder,
      create: async (path: string, markdown: string) => {
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
        return created;
      }
    },
    metadataCache: {
      getFileCache: (file: TFile) => ({ frontmatter: cachedFrontmatter.get(file) })
    },
    fileManager: {
      processFrontMatter: async (
        file: TFile,
        update: (frontmatter: Record<string, unknown>) => void
      ) => {
        frontmatterWriteAttempts += 1;
        if (frontmatterWriteAttempts <= (options.failFrontmatterWrites ?? 0)) {
          throw new Error("simulated task frontmatter write failure");
        }
        const frontmatter = cachedFrontmatter.get(file);
        if (!frontmatter) throw new Error("Missing task frontmatter fixture.");
        update(frontmatter);
      }
    }
  } as unknown as App;
  return { app, markdownWrites, createdPaths };
}
