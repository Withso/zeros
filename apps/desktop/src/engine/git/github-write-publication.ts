import type { Workspace } from "./types";
import { runGit } from "./git-exec";
import { GitError } from "./errors";

/** The proxy and the eventual Git operation must name the same publication. */
export async function githubWritePublication(workspace: Pick<Workspace, "path" | "branch" | "baseBranch">, operation: string): Promise<{ branch: string; baseBranch: string }> {
  if (operation === "git.push" || operation === "gh.prCreate") {
    const { stdout } = await runGit(workspace.path, ["rev-parse", "--abbrev-ref", "HEAD"], { readOnly: true });
    const branch = stdout.trim();
    if (!branch || branch === "HEAD") throw new GitError({ code: "VALIDATION_FAILED",
      message: "Cannot publish while this workspace has a detached HEAD.", remediation: "Check out a branch, then retry." });
    return { branch, baseBranch: workspace.baseBranch };
  }
  return { branch: workspace.branch, baseBranch: workspace.baseBranch };
}
