import { realpathSync } from "node:fs";
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

function canonical(dir: string): string {
  let current = path.resolve(dir);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(dir);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function within(dir: string, root: string): boolean {
  const relative = path.relative(canonical(root), canonical(dir));
  // A child named "..notes" is inside; only ".." itself or "../…" leaves.
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Git splits the ceiling list on the path delimiter, so a root that contains
 * it cannot be listed as is. For a Git call inside that root, its deepest
 * listable ancestor still stops discovery before any enclosing repository.
 * Calls elsewhere get no such ancestor, so a repository rooted there keeps
 * resolving from its own subfolders. */
function ceilingFor(root: string, cwd: string | undefined): string | null {
  const resolved = path.resolve(root);
  if (!resolved.includes(path.delimiter)) return resolved;
  if (!cwd || !within(cwd, resolved)) return null;
  let dir = resolved;
  while (dir.includes(path.delimiter)) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return dir;
}

/** Git applies each leading `-C <dir>` before discovery, so the directory it
 * searches from is the process cwd resolved through them. */
export function effectiveGitDirectory(cwd: string | undefined, args: readonly string[]): string | undefined {
  let dir = cwd;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-C" && index + 1 < args.length) {
      const next = args[++index]!;
      if (next) dir = path.resolve(dir ?? process.cwd(), next);
    } else if (arg === "-c" || arg === "--config-env" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") {
      index++;
    } else if (!arg.startsWith("-")) break;
  }
  return dir;
}

/** Git does not chdir up into a ceiling directory during repository
 * discovery, so nothing at or above a managed root can be adopted from inside
 * it. Repositories outside the roots, and healthy checkouts below them, resolve
 * as before. An inherited ceiling list is kept byte for byte after the managed
 * roots: its empty-entry marker only stops symlink resolution for the entries
 * that follow it. `cwd` is the Git call's working directory. */
export function withWorkspaceCeiling(env: NodeJS.ProcessEnv, cwd?: string, args: readonly string[] = []): NodeJS.ProcessEnv {
  cwd = effectiveGitDirectory(cwd, args);
  const roots = [...new Set(managedWorkspaceRoots().flatMap((root) => {
    const ceiling = ceilingFor(root, cwd);
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
