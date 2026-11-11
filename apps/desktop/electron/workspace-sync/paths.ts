import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isSyncLinkTarget, isSyncPath, type SyncEntry } from "@zeros/protocol/workspace-sync";

export type SyncProblem = { path: string; reason: "invalid_path" | "not_nfc" | "case_collision" | "symlink_outside" | "unsafe_parent" | "local_file" | "type_conflict" | "changed" };

/** APFS is case-insensitive by default and normalizes Unicode: two cloud paths
 * that fold together cannot both exist here. */
export const foldKey = (path: string) => path.normalize("NFC").toLocaleLowerCase("en-US");

/** The cloud paths this Mac may write, in order. A path must pass the wire rule
 * and be NFC; a link target must stay inside the root; of paths that fold
 * together, the first (by byte order) wins and the rest are reported. */
export function admitEntries(entries: readonly SyncEntry[]): { admitted: SyncEntry[]; problems: SyncProblem[] } {
  const admitted: SyncEntry[] = [], problems: SyncProblem[] = [], seen = new Map<string, string>();
  for (const entry of [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (!isSyncPath(entry.path)) { problems.push({ path: entry.path, reason: "invalid_path" }); continue; }
    if (entry.path.normalize("NFC") !== entry.path) { problems.push({ path: entry.path, reason: "not_nfc" }); continue; }
    if (entry.symlink !== undefined && !isSyncLinkTarget(entry.path, entry.symlink)) { problems.push({ path: entry.path, reason: "symlink_outside" }); continue; }
    // A file cannot also be a directory of another admitted path (a/b and a/b/c).
    const key = foldKey(entry.path), first = seen.get(key);
    if (first !== undefined) { problems.push({ path: entry.path, reason: "case_collision" }); continue; }
    seen.set(key, entry.path);
    admitted.push(entry);
  }
  const keys = new Set(admitted.map(entry => foldKey(entry.path)));
  return {
    admitted: admitted.filter(entry => {
      const parts = foldKey(entry.path).split("/");
      for (let index = 1; index < parts.length; index++) if (keys.has(parts.slice(0, index).join("/"))) { problems.push({ path: entry.path, reason: "type_conflict" }); return false; }
      return true;
    }),
    problems,
  };
}

/** Every parent of `path` under `root` is a real directory (never a symlink),
 * created one level at a time when missing. Returns the absolute parent, or
 * null when any component is unsafe. Nothing is created outside the root. */
export async function safeParent(root: string, path: string): Promise<string | null> {
  if (!isSyncPath(path)) return null;
  const parts = path.split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let info = await lstat(current).catch(() => null);
    if (!info) {
      await mkdir(current).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
      info = await lstat(current).catch(() => null);
    }
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return null;
  }
  return current;
}
