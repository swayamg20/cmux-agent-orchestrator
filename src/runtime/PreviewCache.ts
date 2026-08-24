import type { CmuxPreview } from "../cmux/types";

interface CacheEntry {
  preview: CmuxPreview;
  bytes: number;
}

export interface PreviewCacheLimits {
  entries: number;
  bytes: number;
}

export class PreviewCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;

  constructor(private readonly limits: PreviewCacheLimits = { entries: 20, bytes: 1024 * 1024 }) {
    if (limits.entries < 1 || limits.bytes < 1) throw new Error("Preview cache limits must be positive.");
  }

  get(key: string): CmuxPreview | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry.preview };
  }

  peek(key: string): CmuxPreview | null {
    const entry = this.entries.get(key);
    return entry ? { ...entry.preview } : null;
  }

  set(key: string, preview: CmuxPreview): void {
    const existing = this.entries.get(key);
    if (existing) this.totalBytes -= existing.bytes;
    this.entries.delete(key);
    const bytes = Buffer.byteLength(preview.text, "utf8");
    this.entries.set(key, { preview: { ...preview }, bytes });
    this.totalBytes += bytes;
    this.prune();
  }

  retain(keys: ReadonlySet<string>): void {
    for (const [key, entry] of this.entries) {
      if (!keys.has(key)) {
        this.entries.delete(key);
        this.totalBytes -= entry.bytes;
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get byteSize(): number {
    return this.totalBytes;
  }

  private prune(): void {
    while (this.entries.size > this.limits.entries || this.totalBytes > this.limits.bytes) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry] | undefined;
      if (!oldest) return;
      this.entries.delete(oldest[0]);
      this.totalBytes -= oldest[1].bytes;
    }
  }
}
