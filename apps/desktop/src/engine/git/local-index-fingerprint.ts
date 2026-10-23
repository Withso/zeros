import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { resolveGitdir } from "./repo";

/** Index-only observations may be retained between requests. Worktree content
 * is deliberately absent: a filesystem watcher can lag an external edit. */
export async function localIndexFingerprint(root: string): Promise<string | null> {
  try {
    const gitDirectory = await resolveGitdir(root);
    const [physicalRoot, physicalGit, rootInfo, gitInfo] = await Promise.all([
      realpath(root), realpath(gitDirectory), stat(root, { bigint: true }), stat(gitDirectory, { bigint: true }),
    ]);
    let index: string;
    try {
      const info = await lstat(path.join(physicalGit, "index"), { bigint: true });
      if (!info.isFile()) return null;
      index = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].join(":");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      index = "missing";
    }
    return JSON.stringify([physicalRoot, physicalGit, String(rootInfo.dev), String(rootInfo.ino), String(gitInfo.dev), String(gitInfo.ino), index]);
  } catch {
    return null;
  }
}
