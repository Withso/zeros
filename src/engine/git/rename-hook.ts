// Roadmap 03a follow-up C: background-rename hook.
//
// When the user sends their first prompt to a fresh workspace, the
// renderer calls workspace_propose_branch_name → this function. We
// derive a semantic branch name from the prompt heuristically, rename
// the branch on disk, and mark workspace_meta so subsequent prompts
// don't trigger another rename.
//
// This is a "best-effort" feature — if the prompt produces no useful
// keywords we leave the auto-generated "zeros/calm-river-9a2f" name in
// place. The renderer can still surface a manual rename UI for that
// case.

import { GitError } from "./errors";
import { branchDisplayName, deriveBranchNameFromPrompt } from "./naming";
import { renameBranch } from "./branch";
import {
  getWorkspaceById,
  getWorkspaceMeta,
  setWorkspaceMeta,
} from "./state";

const META_KEY_RENAMED_AT = "branch_renamed_at";

export interface ProposeBranchRenameOptions {
  workspaceId: string;
  /** The user's first message to the agent. Free-form text. */
  prompt: string;
  /** When true, ignore the "already renamed" check and force a
   *  re-rename. Renderer-driven retry only — default false. */
  force?: boolean;
}

export interface ProposeBranchRenameResult {
  /** True if a rename actually happened. False means: either the
   *  workspace was already renamed (idempotence) or no useful name
   *  could be derived from the prompt. */
  renamed: boolean;
  /** The branch name after this call. Either the new one or the
   *  pre-existing one — always reflects current on-disk state. */
  branch: string;
  /** When renamed=false, explains *why* so the renderer can choose to
   *  surface a manual-rename affordance. */
  reason?: "already-renamed" | "no-keywords" | "validation-failed";
}

/** Try to derive a semantic name from the user's first prompt and
 *  rename the workspace branch to it. Idempotent — running twice on
 *  the same workspace is a no-op unless `force` is set. */
export async function proposeBranchRename(
  opts: ProposeBranchRenameOptions,
): Promise<ProposeBranchRenameResult> {
  const ws = getWorkspaceById(opts.workspaceId);
  if (!ws) {
    throw new GitError({
      code: "WORKSPACE_NOT_FOUND",
      message: `Workspace ${opts.workspaceId} not found`,
    });
  }

  if (!opts.force) {
    const alreadyAt = getWorkspaceMeta(opts.workspaceId, META_KEY_RENAMED_AT);
    if (alreadyAt) {
      return {
        renamed: false,
        branch: ws.branch,
        reason: "already-renamed",
      };
    }
  }

  const derived = deriveBranchNameFromPrompt(opts.prompt);
  if (!derived) {
    return {
      renamed: false,
      branch: ws.branch,
      reason: "no-keywords",
    };
  }

  // If the derived name happens to match the existing branch (after stripping
  // whatever prefix it carries), there's nothing to do. Mark renamed so we
  // don't retry. branchDisplayName, not a literal "zeros/" strip: Settings →
  // Git makes the prefix a choice, so a `jordan/Cream` workspace would
  // otherwise never compare equal and would re-rename on every check.
  const currentSlug = branchDisplayName(ws.branch);
  if (currentSlug === derived) {
    setWorkspaceMeta(
      opts.workspaceId,
      META_KEY_RENAMED_AT,
      String(Date.now()),
    );
    return { renamed: false, branch: ws.branch, reason: "already-renamed" };
  }

  try {
    await renameBranch({
      workspaceId: opts.workspaceId,
      newName: derived,
    });
  } catch (err) {
    if (err instanceof GitError && err.code === "VALIDATION_FAILED") {
      return { renamed: false, branch: ws.branch, reason: "validation-failed" };
    }
    throw err;
  }
  setWorkspaceMeta(opts.workspaceId, META_KEY_RENAMED_AT, String(Date.now()));
  // Read the row back rather than re-deriving `zeros/${derived}`: renameBranch
  // preserves the workspace's OWN prefix, which is no longer guaranteed to be
  // `zeros/`. Reporting a branch that doesn't exist would strand the caller.
  const renamed = getWorkspaceById(opts.workspaceId);
  return { renamed: true, branch: renamed?.branch ?? ws.branch };
}
