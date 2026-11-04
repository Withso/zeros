import { constants } from "node:fs";
import { link, lstat, mkdtemp, open, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { commandRunner } from "./commands";
import { WorkspaceError } from "./scope";

const LIMIT = 64 * 1024 * 1024;
const changed = () => new WorkspaceError("GIT_INDEX_CHANGED", "The Git index changed during turn reset. Try again.");

export async function withResetIndex(
  root: string, path: string, revision: string | null, expected: string, publishFile: () => Promise<void>,
): Promise<void> {
  const git = commandRunner(root);
  const index = (await git("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.replace(/\n$/, "");
  if (!isAbsolute(index) || index.includes("\0")) throw changed();
  const directory = await mkdtemp(join(dirname(index), "zeros-reset-index-"));
  const candidate = join(directory, "index"), privateLock = join(directory, "lock"), retired = join(directory, "retired-lock");
  const lockPath = `${index}.lock`;
  let acquired = false;
  const lock = await open(privateLock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const owner = await lock.stat();
  const owns = (entry: { dev: number; ino: number }) => entry.dev === owner.dev && entry.ino === owner.ino;
  const assertOwned = async () => { if (!owns(await lstat(lockPath))) throw changed(); };
  try {
    // Git writers honor index.lock; the private candidate stays unpublished
    // until the checked file publication succeeds under that same lock.
    try { await link(privateLock, lockPath); acquired = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkspaceError("GIT_INDEX_LOCKED", "Git is updating the index. Try the reset again.");
      throw error;
    }
    const source = await open(index, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    let update = false;
    if (source) {
      try {
        const before = await source.stat();
        if (!before.isFile()) throw changed();
        if (before.size > LIMIT) throw new WorkspaceError("GIT_OUTPUT_TOO_LARGE", "The Git index is too large to reset.");
        const bytes = Buffer.alloc(before.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await source.read(bytes, offset, bytes.length - offset, null);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await source.stat();
        if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw changed();
        await writeFile(candidate, bytes.subarray(0, offset), { flag: "wx", mode: before.mode & 0o777 });
      } finally { await source.close(); }
      const isolated = commandRunner(root, { GIT_INDEX_FILE: candidate });
      const entries = (await isolated("git", ["ls-files", "--stage", "-z", "--", `:(literal)${path}`], { readOnly: true })).stdout.split("\0").filter(Boolean);
      const fields = entries[0]?.split("\t", 1)[0]?.split(" ");
      update = entries.length === 1 && fields?.[1] === expected && fields[2] === "0";
      if (update) await isolated("git", revision
        ? ["restore", `--source=${revision}`, "--staged", "--", `:(literal)${path}`]
        : ["update-index", "--force-remove", "--", path]);
    }
    await assertOwned();
    await publishFile();
    if (update) {
      await assertOwned();
      await rename(candidate, index);
    }
  } finally {
    if (acquired) {
      // A replaced lock belongs to another writer. Capture before inspecting
      // it, then restore without overwrite and retain its private alias.
      await rename(lockPath, retired).then(async () => {
        if (owns(await lstat(retired))) await unlink(retired);
        else await link(retired, lockPath).catch(() => {});
      }).catch(() => {});
    }
    await lock.close();
    await unlink(privateLock).catch(() => {});
    await unlink(candidate).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
}
