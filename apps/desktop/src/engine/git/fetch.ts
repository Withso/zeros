// `git fetch` with optional --prune. Pruning gone branches
// is a common post-merge cleanup, so we make it a one-flag toggle.

import { getWorkspace } from "./worktree";
import { runGit, assertSafeGitRef } from "./git-exec";
import { resolveRepoGit } from "../settings/repo-git";
import { fetchCloudHistory } from "./cloud-history-fetch";
import { CloudWorkspaceCheckoutSourceSchema } from "@zeros/protocol/cloud-computer-v2";

export interface FetchOptions {
  workspaceId: string;
  /** When true, also runs `--prune` so refs deleted on the remote are
   *  reflected locally. Run this after merge to keep
   *  `git_list_branches` honest. */
  prune?: boolean;
  /** Remote name. Defaults to the repo's configured `git.remote` ("origin"). */
  remote?: string;
  /** Explicit, bounded full-history fetch for cloud checkouts only. */
  unshallow?: boolean;
}

export interface FetchResult {
  /** Stderr lines from git — fetch progress + summary land here. */
  summary: string;
  historyLimited?: true;
}

export async function fetch(opts: FetchOptions): Promise<FetchResult> {
  const ws = getWorkspace(opts.workspaceId);
  if (opts.unshallow && ws.placement !== "cloud")
    throw new Error("Full-history fetching is only available for cloud workspaces");
  const remote = opts.remote ?? resolveRepoGit(ws.repoRoot).remote;
  assertSafeGitRef(remote, "remote");
  if (opts.unshallow) {
    const shallow = (await runGit(ws.path, ["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true";
    if (!shallow) return { summary: "" };
    assertSafeGitRef(ws.baseBranch, "target branch");
    const saved = await runGit(ws.path, ["config", "--local", "--no-includes", "--get", "zeros.cloud-source"]).catch(() => null);
    let source: string | undefined;
    if (saved?.stdout.trim()) {
      try { source = CloudWorkspaceCheckoutSourceSchema.parse(JSON.parse(saved.stdout)).revision; }
      catch { throw new Error("Cloud Git source metadata is invalid"); }
    }
    const args = ["fetch", "--unshallow", "--no-tags", "--no-recurse-submodules", "--no-auto-maintenance"];
    if (opts.prune) args.push("--prune");
    // HEAD may already include unpublished agent commits. Fetch the admitted
    // source, not an unpublished local SHA or the remote's unrelated HEAD.
    args.push("--", remote, ...(source
      ? [source, `+refs/heads/${ws.baseBranch}:refs/remotes/${remote}/${ws.baseBranch}`]
      : [`+refs/heads/*:refs/remotes/${remote}/*`]));
    return fetchCloudHistory(ws.path, args);
  }
  const args = ["fetch"];
  if (opts.prune) args.push("--prune");
  args.push(remote);
  const { stderr } = await runGit(ws.path, args, { timeoutMs: 60_000 });
  return { summary: stderr.trim() };
}
