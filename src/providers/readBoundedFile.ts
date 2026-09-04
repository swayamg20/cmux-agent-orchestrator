import { open } from "node:fs/promises";

export interface BoundedUtf8File {
  content: string;
  modifiedAt: number;
}

export async function readBoundedUtf8File(
  filename: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<BoundedUtf8File | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("Provider metadata byte limit must be a non-negative safe integer.");
  }
  throwIfAborted(signal);
  const handle = await open(filename, "r");
  try {
    throwIfAborted(signal);
    const details = await handle.stat();
    throwIfAborted(signal);
    if (!details.isFile() || details.size > maxBytes) return null;

    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      throwIfAborted(signal);
      const next = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      bytesRead += next.bytesRead;
      if (next.bytesRead === 0) break;
    }
    throwIfAborted(signal);
    if (bytesRead > maxBytes) return null;
    return {
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      modifiedAt: details.mtimeMs
    };
  } finally {
    await handle.close();
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Provider metadata request was cancelled.");
  error.name = "AbortError";
  throw error;
}
