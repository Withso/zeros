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

/** Git does not chdir up into a ceiling directory during repository
 * discovery, so nothing at or above a managed root can be adopted from inside
 * it. Repositories outside the roots, and healthy checkouts below them, resolve
 * as before. Existing ceilings are kept. */
export function withWorkspaceCeiling(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const roots = managedWorkspaceRoots().filter(
    (root) => path.isAbsolute(root) && !root.includes(path.delimiter),
  );
  if (roots.length === 0) return env;
  const existing = (env.GIT_CEILING_DIRECTORIES ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  return {
    ...env,
    GIT_CEILING_DIRECTORIES: [...new Set([...existing, ...roots])].join(
      path.delimiter,
    ),
  };
}
