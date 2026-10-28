import { mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openLocalFile } from "../../../src/engine/local-orchestration/filesystem";

/** Native thumbnail services reopen paths in another process. Give them an
 * owned, immutable copy rather than a mutable path inside an opened project. */
export async function stageThumbnailSource(source: string, maxBytes: number, extension = path.extname(source)) {
  const input = await openLocalFile(source);
  let directory: string | undefined;
  try {
    const stat = await input.stat();
    if (!stat.isFile()) throw new Error("not a regular file");
    if (stat.size > maxBytes) throw Object.assign(new Error("image is too large to thumbnail safely"), { code: "EFBIG", bytes: stat.size });
    directory = await mkdtemp(path.join(os.tmpdir(), "zeros-thumbnail-"));
    if (!/^\.[a-z0-9]{1,8}$/i.test(extension)) throw new Error("Invalid thumbnail extension.");
    const target = path.join(directory, `source${extension}`);
    const output = await open(target, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(Math.min(stat.size + 1, 1024 * 1024));
      let copied = 0;
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        copied += bytesRead;
        if (copied > stat.size) throw new Error("image changed during read");
        await output.writeFile(buffer.subarray(0, bytesRead));
      }
      const after = await input.stat();
      if (copied !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
        throw new Error("image changed during read");
    } finally { await output.close(); }
    const owned = directory;
    return { path: target, bytes: stat.size, dispose: () => rm(owned, { recursive: true, force: true }) };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  } finally { await input.close(); }
}
