// Working-tree mutation ops: reset, discard, restore-from, clean (D.3).
// All shell out via git-exec. The destructive ones (`--hard` reset,
// clean) require an explicit `confirm: true` so a mis-wired UI button
// can't wipe work silently — the IPC layer surfaces the confirmation.

import { resolveRepoForGitOp } from "./worktree";
import { runGit } from "./git-exec";
import { requireGitPaths, validateGitReset, gitResetArgs, gitRestoreArgs } from "@zeros/protocol/git-review-actions";
import { GitError } from "./errors";
import { prepareDesignSafeIntegration } from "./design-draft-guard";

const invalid = (message: string) => new GitError({ code: "VALIDATION_FAILED", message });
const requirePaths = (paths: unknown, context: string) => requireGitPaths(paths, context, invalid);

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
  const ws = await resolveRepoForGitOp(opts.workspaceId);
  const { mode, ref } = validateGitReset(opts, invalid);
  const target =
    mode === "hard"
      ? await prepareDesignSafeIntegration({
          workspaceId: opts.workspaceId,
          path: ws.path,
          repoRoot: ws.repoRoot,
          target: ref,
          operation: "Hard reset",
          comparison: "tree-transition",
          rejectAnyDirtyDesign: true,
        })
      : ref;
  await runGit(ws.path, gitResetArgs(mode, target));
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
  await runGit(ws.path, [
    "restore",
    "--staged",
    "--worktree",
    "--",
    ...paths.map((candidate) => `:(literal)${candidate}`),
  ]);
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
  const ws = await resolveRepoForGitOp(opts.workspaceId);
  await runGit(ws.path, gitRestoreArgs(opts, invalid));
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
  const ws = await resolveRepoForGitOp(opts.workspaceId);
  if (opts.confirm !== true) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "clean permanently deletes untracked files; pass confirm:true",
    });
  }
  const args = ["clean", "-f"];
  if (opts.directories !== false) args.push("-d");
  if (opts.paths && opts.paths.length > 0) {
    args.push(
      "--",
      ...requirePaths(opts.paths, "clean").map(
        (candidate) => `:(literal)${candidate}`,
      ),
    );
  }
  const { stdout } = await runGit(ws.path, args);
  // `git clean -f` prints "Removing <path>" per entry.
  const removed = stdout
    .split("\n")
    .map((l) => l.replace(/^Removing /, "").trim())
    .filter(Boolean);
  return { removed };
}
