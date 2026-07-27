// Working-tree mutation ops: reset, discard, restore-from, clean (D.3).
// All shell out via git-exec. The destructive ones (`--hard` reset,
// clean) require an explicit `confirm: true` so a mis-wired UI button
// can't wipe work silently — the IPC layer surfaces the confirmation.

import { getWorkspace, resolveRepoForGitOp } from "./worktree";
import { assertSafeGitRef, runGit } from "./git-exec";
import { GitError } from "./errors";

function requirePaths(paths: unknown, context: string): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `${context}: 'paths' must be a non-empty array of strings`,
    });
  }
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    if (typeof p !== "string" || p.length === 0) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `${context}: paths[${i}] must be a non-empty string`,
      });
    }
    if (p.startsWith("-")) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `${context}: paths[${i}] starts with "-" (looks like a flag)`,
      });
    }
  }
  return paths as string[];
}

// ── reset ────────────────────────────────────────────────

export type ResetMode = "soft" | "mixed" | "hard";

export interface ResetOptions {
  workspaceId: string;
  /** Ref to reset HEAD to. Defaults to "HEAD" (un-stage everything for
   *  mixed; no-op move for soft). */
  ref?: string;
  mode: ResetMode;
  /** Required `true` for mode:'hard' — it discards working-tree changes. */
  confirm?: boolean;
}

export async function reset(opts: ResetOptions): Promise<void> {
  const ws = getWorkspace(opts.workspaceId);
  // Validate the mode against the union before building the git flag. A caller
  // can pass an arbitrary string past the TS type (the IPC handler casts a raw
  // `requireString`), and an unguarded value would be interpolated as
  // `--<value>` AND bypass the hard-confirm gate below (which only fires on
  // exactly "hard") — e.g. `--merge`/`--keep` could mutate the working tree
  // with no confirm. Mirrors the git.diff `mode` validation.
  if (opts.mode !== "soft" && opts.mode !== "mixed" && opts.mode !== "hard") {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `reset: invalid mode '${String(opts.mode)}' (expected soft|mixed|hard)`,
    });
  }
  if (opts.mode === "hard" && opts.confirm !== true) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "reset --hard discards working-tree changes; pass confirm:true",
    });
  }
  const ref = assertSafeGitRef(opts.ref ?? "HEAD", "reset.ref");
  await runGit(ws.path, ["reset", `--${opts.mode}`, ref]);
}

// ── discard (restore working tree) ───────────────────────

export interface DiscardOptions {
  workspaceId: string;
  paths: string[];
}

/** Fully discard uncommitted changes to the given (tracked, in-HEAD) paths,
 *  reverting BOTH the index and the working tree to HEAD
 *  (`git restore --staged --worktree`). Handles staged, unstaged, and
 *  staged-and-edited files in one shot — the "Discard changes" affordance in
 *  the Changes tab. New files (untracked / staged-add) are not in HEAD, so
 *  they're deleted via clean() instead of restored here. */
export async function discardFiles(opts: DiscardOptions): Promise<void> {
  const ws = await resolveRepoForGitOp(opts.workspaceId);
  const paths = requirePaths(opts.paths, "discard");
  await runGit(ws.path, ["restore", "--staged", "--worktree", "--", ...paths]);
}

// ── restore from a source ref ────────────────────────────

export interface RestoreFromOptions {
  workspaceId: string;
  paths: string[];
  /** Ref/commit to restore the paths' content from (e.g. "HEAD~1"). */
  source: string;
  /** Also overwrite the index (default true so the file matches source). */
  staged?: boolean;
}

export async function restoreFrom(opts: RestoreFromOptions): Promise<void> {
  const ws = getWorkspace(opts.workspaceId);
  const paths = requirePaths(opts.paths, "restoreFrom");
  assertSafeGitRef(opts.source, "restoreFrom.source");
  const args = ["restore", "--source", opts.source, "--worktree"];
  if (opts.staged !== false) args.push("--staged");
  args.push("--", ...paths);
  await runGit(ws.path, args);
}

// ── clean ────────────────────────────────────────────────

export interface CleanOptions {
  workspaceId: string;
  /** Limit to these paths; omit to clean the whole worktree. */
  paths?: string[];
  /** Also remove untracked directories (`-d`). Default true. */
  directories?: boolean;
  /** Required `true` — clean permanently deletes untracked files. */
  confirm: boolean;
}

export interface CleanResult {
  removed: string[];
}

export async function clean(opts: CleanOptions): Promise<CleanResult> {
  const ws = getWorkspace(opts.workspaceId);
  if (opts.confirm !== true) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "clean permanently deletes untracked files; pass confirm:true",
    });
  }
  const args = ["clean", "-f"];
  if (opts.directories !== false) args.push("-d");
  if (opts.paths && opts.paths.length > 0) {
    args.push("--", ...requirePaths(opts.paths, "clean"));
  }
  const { stdout } = await runGit(ws.path, args);
  // `git clean -f` prints "Removing <path>" per entry.
  const removed = stdout
    .split("\n")
    .map((l) => l.replace(/^Removing /, "").trim())
    .filter(Boolean);
  return { removed };
}
