import path from "node:path";
import {
  zerosDesignWorkspacesRoot,
  zerosStateRoot,
  zerosWorkspacesRoot,
} from "../db/paths";

let rootsOverride: readonly string[] | null = null;

/** Folders that hold Zeros-owned workspace checkouts. A checkout whose `.git`
 * link was lost must fail its Git commands; it must never resolve to a
 * repository that encloses these folders, such as a home-directory dotfiles
 * repository, where status, stage, commit or push would act on the wrong
 * project. */
export function managedWorkspaceRoots(): readonly string[] {
  return rootsOverride ?? [
    zerosWorkspacesRoot(),
    zerosDesignWorkspacesRoot(),
    // Pre-relocation hidden root, still scanned when seeding state.
    path.join(zerosStateRoot(), "worktrees"),
  ];
}

/** Test seam paired with git/state's setStateRootForTesting. */
export function setManagedWorkspaceRootsForTesting(
  roots: readonly string[] | null,
): void {
  rootsOverride = roots;
}

/** Git splits the ceiling list on the path delimiter, so a root that contains
 * it cannot be listed as is. Its deepest ancestor that can be listed still
 * stops discovery before any repository enclosing the root. */
function listableCeiling(root: string): string | null {
  let dir = path.resolve(root);
  while (dir.includes(path.delimiter)) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return dir;
}

/** Git does not chdir up into a ceiling directory during repository
 * discovery, so nothing at or above a managed root can be adopted from inside
 * it. Repositories outside the roots, and healthy checkouts below them, resolve
 * as before. An inherited ceiling list is kept byte for byte after the managed
 * roots: its empty-entry marker only stops symlink resolution for the entries
 * that follow it. */
export function withWorkspaceCeiling(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const roots = [...new Set(managedWorkspaceRoots().flatMap((root) => {
    const ceiling = listableCeiling(root);
    return ceiling ? [ceiling] : [];
  }))];
  if (roots.length === 0) return env;
  const inherited = env.GIT_CEILING_DIRECTORIES;
  return {
    ...env,
    GIT_CEILING_DIRECTORIES: inherited
      ? `${roots.join(path.delimiter)}${path.delimiter}${inherited}`
      : roots.join(path.delimiter),
  };
}
