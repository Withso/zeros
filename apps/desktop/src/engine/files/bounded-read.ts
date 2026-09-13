import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Inspect and read the same descriptor, bounding allocation and rejecting
 * growth or truncation during the read. Symlinked files remain supported. */
export async function readBoundedUtf8File(
  file: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error("Invalid file byte limit.");
  signal?.throwIfAborted();
  // Nonblocking open lets us reject FIFOs without waiting for a writer.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    signal?.throwIfAborted();
    const info = await handle.stat();
    signal?.throwIfAborted();
    if (!info.isFile() || info.size > maxBytes) return null;
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    signal?.throwIfAborted();
    return offset === info.size
      ? bytes.subarray(0, offset).toString("utf8")
      : null;
  } finally {
    await handle.close();
  }
}
