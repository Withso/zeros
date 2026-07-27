// Stage / unstage paths in a workspace. Both shell out to git — there
// is no benefit to going through isomorphic-git for these, and shelling
// out automatically honors .gitignore + .gitattributes the same way the
// rest of the user's git tooling does.

import { getWorkspace, resolveRepoForGitOp } from "./worktree";
import { runGit } from "./git-exec";
import { GitError } from "./errors";

export interface StageOptions {
  workspaceId: string;
  paths: string[];
}

function validatePaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "stage/unstage: 'paths' must be a non-empty array of strings",
    });
  }
  for (let i = 0; i < paths.length; i++) {
    if (typeof paths[i] !== "string" || (paths[i] as string).length === 0) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `stage/unstage: paths[${i}] must be a non-empty string`,
      });
    }
    // Defense in depth — even though execFile won't shell-interpret,
    // we don't want path traversal that escapes the worktree.
    if ((paths[i] as string).startsWith("-")) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `stage/unstage: paths[${i}] starts with "-" (looks like a flag)`,
      });
    }
  }
  return paths as string[];
}

/** Stage one or more paths via `git add -- <paths...>`. Honors
 *  .gitignore (use git_status to find untracked-but-not-ignored paths
 *  first). */
export async function stagePaths(opts: StageOptions): Promise<void> {
  const ws = await resolveRepoForGitOp(opts.workspaceId);
  const paths = validatePaths(opts.paths);
  await runGit(ws.path, ["add", "--", ...paths]);
}

/** Unstage one or more paths via `git restore --staged -- <paths...>`.
 *  Leaves the working-tree content untouched. */
export async function unstagePaths(opts: StageOptions): Promise<void> {
  const ws = await resolveRepoForGitOp(opts.workspaceId);
  const paths = validatePaths(opts.paths);
  await runGit(ws.path, ["restore", "--staged", "--", ...paths]);
}

// ── hunk-level staging (D.6) ─────────────────────────────

export interface ApplyHunkOptions {
  workspaceId: string;
  /** A unified-diff fragment (one or more hunks for a single file). The
   *  UI builds this from the @pierre/diffs line selection; it must be a
   *  well-formed patch with file headers + `@@` hunk headers. */
  patch: string;
}

function validatePatch(patch: unknown): string {
  if (typeof patch !== "string" || patch.trim().length === 0) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "stageHunk/unstageHunk/discardHunk: 'patch' must be a non-empty unified diff",
    });
  }
  // `git apply` requires a trailing newline on the patch stream.
  return patch.endsWith("\n") ? patch : patch + "\n";
}

/** Stage a selected hunk: `git apply --cached` of the patch on stdin. */
export async function stageHunk(opts: ApplyHunkOptions): Promise<void> {
  const ws = getWorkspace(opts.workspaceId);
  await runGit(ws.path, ["apply", "--cached"], {
    input: validatePatch(opts.patch),
    mapErrorCode: () => "GIT_COMMAND_FAILED",
  });
}

/** Unstage a selected hunk: reverse-apply the patch against the index. */
export async function unstageHunk(opts: ApplyHunkOptions): Promise<void> {
  const ws = getWorkspace(opts.workspaceId);
  await runGit(ws.path, ["apply", "--cached", "--reverse"], {
    input: validatePatch(opts.patch),
    mapErrorCode: () => "GIT_COMMAND_FAILED",
  });
}

/** Discard a selected hunk from the working tree: reverse-apply to the
 *  worktree (no --cached). Destructive — the UI should confirm. */
export async function discardHunk(opts: ApplyHunkOptions): Promise<void> {
  const ws = getWorkspace(opts.workspaceId);
  await runGit(ws.path, ["apply", "--reverse"], {
    input: validatePatch(opts.patch),
    mapErrorCode: () => "GIT_COMMAND_FAILED",
  });
}
