import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

/** 12.zz: `design workspaces/` is obsolete (Design is a mode of a normal workspace;
 * nothing creates the folder any more). Remove it only when it holds nothing: empty
 * folders and Finder's .DS_Store files. Anything else (a file, a symlink, a deep or
 * huge tree) leaves the whole folder exactly as it is. Older workspace rows that
 * still point inside it are recognised by the engine as before. */
const MAX_ENTRIES = 1_000, MAX_DEPTH = 4;

export async function removeEmptyLegacyDesignFolder(root: string): Promise<boolean> {
  const info = await lstat(root).catch(() => null);
  if (!info?.isDirectory()) return false;
  const directories: string[] = [], finderFiles: string[] = [];
  let entries = 0;
  const walk = async (folder: string, depth: number): Promise<boolean> => {
    directories.push(folder);
    for (const name of await readdir(folder)) {
      if (++entries > MAX_ENTRIES) return false;
      const path = join(folder, name), entry = await lstat(path);
      if (entry.isDirectory() && !entry.isSymbolicLink()) { if (depth >= MAX_DEPTH || !await walk(path, depth + 1)) return false; }
      else if (entry.isFile() && name === ".DS_Store") finderFiles.push(path);
      else return false;
    }
    return true;
  };
  if (!await walk(root, 0).catch(() => false)) return false;
  for (const file of finderFiles) await unlink(file).catch(() => {});
  // Deepest first; rmdir never removes a folder that gained something meanwhile.
  for (const folder of directories.reverse()) if (!await rmdir(folder).then(() => true, () => false)) return false;
  return true;
}
