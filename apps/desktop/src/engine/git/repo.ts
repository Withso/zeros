// Repository-level helpers. Two concerns live here:
//
//  1. `repoSlug` derivation from a git remote URL — turns
//     "git@github.com:Acme/example.git" or "https://github.com/Acme/example"
//     into "acme-example". The slug becomes the directory under
//     worktreesRoot() (~/zeros/workspaces), so it must be filesystem-safe and stable.
//
//  2. `resolveGitdir(worktreePath)` — when `.git` is a *file* (which is
//     always the case for `git worktree add` outputs), the file contains
//     "gitdir: /abs/path/to/real/.git/worktrees/<name>". isomorphic-git
//     does NOT auto-follow this; callers must pass the resolved gitdir
//     as the `gitdir` option. Without this, every read call against a
//     linked worktree throws "could not find HEAD".

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { GitError } from "./errors";
import { runFile } from "./git-exec";

/** Derive a filesystem-safe repo slug from an origin URL.
 *  Examples:
 *    git@github.com:Acme/example.git           → acme-example
 *    https://github.com/Acme/example           → acme-example
 *    https://gitlab.com/group/sub/project.git  → group-sub-project
 *
 *  We intentionally drop the host so worktrees for the same logical
 *  project don't fragment if the user re-clones via SSH after HTTPS. */
export function repoSlugFromOriginUrl(url: string): string {
  if (!url || typeof url !== "string") {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "repoSlugFromOriginUrl: origin URL must be a non-empty string",
    });
  }
  // Strip protocol + host. Handle both ssh-style (git@host:path) and
  // https-style (https://host/path).
  let rest: string;
  const sshMatch = url.match(/^[^@]+@[^:]+:(.+)$/);
  if (sshMatch) {
    rest = sshMatch[1];
  } else {
    const httpMatch = url.match(/^https?:\/\/[^/]+\/(.+)$/);
    rest = httpMatch ? httpMatch[1] : url;
  }
  // Drop trailing .git and leading/trailing slashes.
  rest = rest.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (!rest) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `repoSlugFromOriginUrl: cannot derive slug from "${url}"`,
    });
  }
  // Replace path separators with hyphens, lowercase everything, collapse
  // any remaining non-[a-z0-9-] runs.
  return rest
    .toLowerCase()
    .replace(/[/\\]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Read `origin` from a repo root. Throws GitError if not a repo or if
 *  there's no origin remote (we don't auto-fall-back to another remote
 *  because the slug would silently change between calls). */
export async function readOriginUrl(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await runFile(
      "git",
      ["-C", repoRoot, "remote", "get-url", "origin"],
      { maxBufferBytes: 1024 * 1024 },
    );
    return stdout.trim();
  } catch (err) {
    throw new GitError({
      code: "NOT_A_REPO",
      message: `Could not read origin URL from ${repoRoot}. Run \`git remote add origin <url>\` first.`,
      cause: err,
    });
  }
}

/** Check if a path is the root of a git repository (or any working
 *  directory under one). Cheap — just runs `git rev-parse --git-dir` and
 *  returns a boolean. Used by IPC validation before destructive ops. */
export async function isRepo(p: string): Promise<boolean> {
  try {
    await runFile("git", ["-C", p, "rev-parse", "--git-dir"], {
      maxBufferBytes: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

/** Resolve the gitdir for a worktree path. Returns:
 *
 *   - For the primary worktree (`.git` is a directory): the directory
 *     path itself.
 *   - For a linked worktree (`.git` is a file): the absolute path read
 *     from the file's "gitdir:" line, with `~` and relative paths
 *     resolved against the worktree's parent.
 *
 *  Pass the returned value as isomorphic-git's `gitdir` option. The
 *  `dir` option stays as the worktree path. */
export async function resolveGitdir(worktreePath: string): Promise<string> {
  const dotGit = path.join(worktreePath, ".git");
  let st;
  try {
    st = await stat(dotGit);
  } catch (err) {
    throw new GitError({
      code: "WORKTREE_NOT_FOUND",
      message: `No .git at ${worktreePath} — not a worktree?`,
      cause: err,
    });
  }
  if (st.isDirectory()) {
    return dotGit;
  }
  // Linked worktree — .git is a file pointing at the real gitdir.
  // Format is exactly one line: "gitdir: <path>\n".
  const raw = (await readFile(dotGit, "utf8")).trim();
  const m = raw.match(/^gitdir:\s*(.+)$/);
  if (!m) {
    throw new GitError({
      code: "WORKTREE_NOT_FOUND",
      message: `.git at ${worktreePath} is a file but has no "gitdir:" line — corrupted worktree pointer?`,
      context: { contents: raw },
    });
  }
  const target = m[1].trim();
  // The gitdir line is usually absolute, but `git worktree add` historically
  // used relative paths on Windows. Resolve against the worktree's parent
  // for safety.
  return path.isAbsolute(target) ? target : path.resolve(worktreePath, target);
}

/** Probe a worktree for in-progress git state (merge / rebase / cherry-pick).
 *  Used by detach-mode to refuse to start when the user is in the middle
 *  of a multi-step operation that detach would interleave with. */
export async function getInProgressState(
  worktreePath: string,
): Promise<"merge" | "rebase" | "cherry-pick" | "revert" | null> {
  const gitdir = await resolveGitdir(worktreePath);
  const probes: Array<["merge" | "rebase" | "cherry-pick" | "revert", string]> =
    [
      ["merge", path.join(gitdir, "MERGE_HEAD")],
      ["rebase", path.join(gitdir, "rebase-apply")],
      ["rebase", path.join(gitdir, "rebase-merge")],
      ["cherry-pick", path.join(gitdir, "CHERRY_PICK_HEAD")],
      ["revert", path.join(gitdir, "REVERT_HEAD")],
    ];
  for (const [kind, p] of probes) {
    try {
      await stat(p);
      return kind;
    } catch {
      // Not present — keep probing.
    }
  }
  return null;
}
