import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** Only an empty legacy staging folder or its exact generated ignore file is disposable. */
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
    // Use rmdir so concurrent additions keep this repository folder from being deleted.
    const current = await fs.lstat(directory);
    if (current.dev === before.dev && current.ino === before.ino)
      await fs.rmdir(directory);
  } catch {
    // A cleanup refusal must not prevent a new attachment from being saved.
  } finally {
    await handle?.close().catch(() => {});
  }
}
