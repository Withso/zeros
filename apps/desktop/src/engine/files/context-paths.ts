import fs from "node:fs/promises";
import path from "node:path";

export const CONTEXT_DIR = ".context";
export const LEGACY_CONTEXT_DIR = ".context-graph";

export async function statIfPresent(target: string) {
  return fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

/** Context storage cannot adopt another folder through a symlink. */
export async function assertContextDirectory(
  target: string,
  workspaceRoot: string,
) {
  const relative = path.relative(workspaceRoot, target);
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  )
    throw new Error("context path escapes workspace");
  let current = workspaceRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await statIfPresent(current);
    if (stat && !stat.isDirectory())
      throw new Error(
        "context path exists but is not a directory (symlinks are not supported)",
      );
  }
}
