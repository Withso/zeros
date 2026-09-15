import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** Old imports left a dedicated staging scaffold behind. Only an empty folder
 * or its exact generated ignore file is disposable. Unrecognized contents,
 * interrupted copies and links remain available for manual recovery. */
export async function cleanupLegacyAttachmentStaging(
  contextRoot: string,
): Promise<void> {
  const directory = path.join(contextRoot, ".attachment-staging");
  let handle: fs.FileHandle | undefined;
  try {
    const before = await fs.lstat(directory);
    if (!before.isDirectory()) return;
    const entries = await fs.readdir(directory);
    if (entries.length === 1 && entries[0] === ".gitignore") {
      const ignore = path.join(directory, ".gitignore");
      handle = await fs.open(ignore, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.size !== 2 ||
        opened.nlink !== 1 ||
        (await handle.readFile("utf8")) !== "*\n"
      )
        return;
      const current = await fs.lstat(ignore);
      const parent = await fs.lstat(directory);
      if (
        parent.dev !== before.dev ||
        parent.ino !== before.ino ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino ||
        current.mtimeMs !== opened.mtimeMs ||
        current.ctimeMs !== opened.ctimeMs
      )
        return;
      await handle.close();
      handle = undefined;
      await fs.unlink(ignore);
    } else if (entries.length > 0) return;
    // rmdir refuses anything added concurrently. Never recursively delete this
    // repository path, even when it looks like an old app-owned staging area.
    const current = await fs.lstat(directory);
    if (current.dev === before.dev && current.ino === before.ino)
      await fs.rmdir(directory);
  } catch {
    // A cleanup refusal must not prevent a new attachment from being saved.
  } finally {
    await handle?.close().catch(() => {});
  }
}
