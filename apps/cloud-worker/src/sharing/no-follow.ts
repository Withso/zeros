import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { descriptorPath } from "../workspace/checked-files";

/** Team sharing slice D: the one way legacy cleanup reaches a directory. Every
 * component of the absolute path is opened from the filesystem root as a
 * directory without following a link (each open is relative to the held
 * parent, so a component cannot be swapped behind it), and once a directory
 * owned by this user is reached, nothing below it may be anyone else's.
 * undefined: a component is missing. A link, a non-directory or a foreign
 * directory below an owned one throws. */
/** The walk met a link or non-directory ("linked"), or a foreign directory below this user's ("foreign"). */
export class NoFollowRefusal extends Error {
  constructor(readonly kind: "linked" | "foreign") { super(kind === "linked" ? "A path component is a link or not a directory." : "A directory below this user's belongs to someone else."); }
}
const linked = (error: unknown) => ["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

export async function openDirectoryNoFollow(path: string): Promise<FileHandle | undefined> {
  if (!isAbsolute(path)) throw new Error("An absolute path is required.");
  const parts = normalize(path).split("/").filter(Boolean);
  if (parts.includes("..")) throw new Error("A normalized path is required.");
  const uid = process.getuid?.();
  let handle = await open("/", constants.O_RDONLY | constants.O_DIRECTORY);
  let owned = (await handle.stat()).uid === uid;
  try {
    for (const part of parts) {
      const next = await open(`${descriptorPath(handle)}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        .catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw linked(error) ? new NoFollowRefusal("linked") : error; });
      await handle.close();
      if (!next) return undefined;
      handle = next;
      const mine = (await handle.stat()).uid === uid;
      if (owned && !mine) throw new NoFollowRefusal("foreign");
      owned ||= mine;
    }
    return handle;
  } catch (error) { await handle.close().catch(() => {}); throw error; }
}
