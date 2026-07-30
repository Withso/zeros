// `git fetch` with optional --prune. Workmux-style: pruning gone branches
// is a common post-merge cleanup, so we make it a one-flag toggle.

import { getWorkspace } from "./worktree";
import { runGit, assertSafeGitRef } from "./git-exec";
import { resolveRepoGit } from "../settings/repo-git";

export interface FetchOptions {
  workspaceId: string;
  /** When true, also runs `--prune` so refs deleted on the remote are
   *  reflected locally. Workmux runs this after merge to keep
   *  `git_list_branches` honest. */
  prune?: boolean;
  /** Remote name. Defaults to the repo's configured `git.remote` ("origin"). */
  remote?: string;
}

export interface FetchResult {
  /** Stderr lines from git — fetch progress + summary land here. */
  summary: string;
}

export async function fetch(opts: FetchOptions): Promise<FetchResult> {
  const ws = getWorkspace(opts.workspaceId);
  const remote = opts.remote ?? resolveRepoGit(ws.repoRoot).remote;
  assertSafeGitRef(remote, "remote");
  const args = ["fetch"];
  if (opts.prune) args.push("--prune");
  args.push(remote);
  const { stderr } = await runGit(ws.path, args, { timeoutMs: 60_000 });
  return { summary: stderr.trim() };
}
