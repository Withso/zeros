import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SYNC_LIMITS, isSyncPath } from "@zeros/protocol/workspace-sync";
import type { CommandRunner } from "./commands";

export interface ContextLimits { files: number; bytes: number; visits: number }
const DEFAULT_LIMITS: ContextLimits = { files: SYNC_LIMITS.contextFiles, bytes: SYNC_LIMITS.contextBytes, visits: 200_000 };
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Order 3 (contract 12.x/12.y): `.context/` syncs although Git ignores it, as
 * in Conductor: regular files only, walked depth-first in byte order; never
 * `.context/attachments/`, a directory holding a nested repository (`.git`
 * file or directory), a symlink, or a path the repository ignores when judged
 * without the `.context/` prefix (node_modules and the like). Its own budget
 * (20,000 files, 1 GB in walk order) keeps a huge `.context` from stopping the
 * rest of the sync; the overflow is reported once. */
export async function listContextFiles(root: string, run: CommandRunner, limits: Partial<ContextLimits> = {}): Promise<{ paths: string[]; overflow: boolean }> {
  const bound = { ...DEFAULT_LIMITS, ...limits };
  const base = join(root, ".context");
  const top = await lstat(base).catch(() => null);
  if (!top || !top.isDirectory() || top.isSymbolicLink()) return { paths: [], overflow: false };
  const candidates: Array<{ relative: string; size: number }> = [];
  let visits = 0, truncated = false;
  const walk = async (directory: string, relative: string): Promise<void> => {
    let names: string[];
    try { names = (await readdir(directory)).sort(byteOrder); } catch { return; }
    // A nested repository is skipped whole: its tracked and loose files alike.
    if (relative && names.includes(".git")) return;
    for (const name of names) {
      if (++visits > bound.visits) { truncated = true; return; }
      const child = relative ? `${relative}/${name}` : name;
      if (!relative && name === "attachments") continue;
      if (!isSyncPath(`.context/${child}`)) continue;
      const info = await lstat(join(directory, name)).catch(() => null);
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(join(directory, name), child);
      else if (info.isFile()) candidates.push({ relative: child, size: info.size });
      if (truncated) return;
    }
  };
  await walk(base, "");
  // The repository's own ignore rules, applied as if the files sat at the checkout root.
  const ignored = new Set<string>();
  if (candidates.length) {
    const { stdout } = await run("git", ["check-ignore", "--no-index", "-z", "--stdin"],
      { readOnly: true, input: candidates.map(candidate => candidate.relative).join("\0") + "\0", allowExitCodes: [1], maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
    for (const path of stdout.split("\0")) if (path) ignored.add(path);
  }
  const paths: string[] = [];
  let bytes = 0, overflow = truncated;
  for (const candidate of candidates) {
    if (ignored.has(candidate.relative)) continue;
    // Files over the per-file cap are reported by the tracker; they never spend the budget.
    const spend = candidate.size > SYNC_LIMITS.fileBytes ? 0 : candidate.size;
    if (paths.length >= bound.files || bytes + spend > bound.bytes) { overflow = true; break; }
    paths.push(`.context/${candidate.relative}`); bytes += spend;
  }
  return { paths, overflow };
}
