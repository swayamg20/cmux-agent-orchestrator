import type { CmuxPreview } from "../cmux/types";

interface QueueItem {
  key: string;
  load: () => Promise<CmuxPreview>;
  resolve: (preview: CmuxPreview) => void;
  reject: (error: unknown) => void;
}

export class PreviewScheduler {
  private readonly queue: QueueItem[] = [];
  private readonly promises = new Map<string, Promise<CmuxPreview>>();
  private active = 0;
  private disposed = false;

  constructor(private readonly concurrency = 2) {}

  schedule(key: string, load: () => Promise<CmuxPreview>): Promise<CmuxPreview> {
    const existing = this.promises.get(key);
    if (existing) return existing;
    const promise = new Promise<CmuxPreview>((resolve, reject) => {
      this.queue.push({ key, load, resolve, reject });
      this.drain();
    });
    this.promises.set(key, promise);
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    for (const item of this.queue.splice(0)) item.reject(new Error("Preview scheduler was disposed."));
    this.promises.clear();
  }

  private drain(): void {
    while (!this.disposed && this.active < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.active += 1;
      void item
        .load()
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          this.promises.delete(item.key);
          this.drain();
        });
    }
  }
}
