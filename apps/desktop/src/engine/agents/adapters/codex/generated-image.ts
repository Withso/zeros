import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ContentBlock } from "@zeros/protocol/agent-events";

// Match the existing inline-result bound, including base64 expansion.
export const MAX_IMAGE_CONTENT_LENGTH = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = Math.floor(MAX_IMAGE_CONTENT_LENGTH / 4) * 3;

function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** Native savedPath is an image pointer, never an attachment-store URL. Read
 * off the notification path, without following a symlink at any component.
 * Judge and read one held descriptor; bound even a concurrently growing file. */
export async function readGeneratedImage(savedPath: string): Promise<ContentBlock | undefined> {
  if (!isAbsolute(savedPath) || savedPath.length > 4096 || savedPath.includes("\0")) return;
  // Check the native spelling; normalizing first could erase a missing or
  // symlinked parent before realpath has a chance to reject it.
  const path = savedPath;
  let handle;
  try {
    if (await realpath(path) !== path) return;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.size === 0 || before.size > MAX_IMAGE_BYTES) return;
    const ownsPath = async () => {
      if (await realpath(path) !== path) return false;
      const named = await lstat(path);
      return named.isFile() && named.dev === before.dev && named.ino === before.ino;
    };
    if (!await ownsPath()) return;
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) return;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || !await ownsPath()) return;
    const mimeType = imageMime(bytes);
    if (mimeType) return { type: "image", mimeType, data: bytes.toString("base64") };
  } catch {
    // Missing, unsafe and unreadable files all retain the plain transcript
    // placeholder. Do not log native paths or turn optional media into errors.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
