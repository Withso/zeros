// ──────────────────────────────────────────────────────────
// Workspace target-branch ref — what the agent diffs/PRs against
// ──────────────────────────────────────────────────────────
//
// The first-turn system instruction tells the agent its target branch (for
// `git diff <target>...` and `gh pr create --base`). This resolves that ref
// from the workspace ROW (`ws.baseBranch` — detected at create time, updated
// by the target-branch picker; accurate per workspace, unlike the settings
// default) plus the repo's configured `git.remote`. Remote-qualified only
// when the remote-tracking ref actually resolves, so a local-only repo gets
// a diffable local ref instead of a broken "origin/main".

import { getWorkspaceById } from "./state";
import { refExists } from "./default-branch";
import { resolveRepoGit } from "../settings/repo-git";

/** The ref the agent in `workspaceId` should treat as its target branch —
 *  `<remote>/<base>` when that remote-tracking ref exists, the plain base
 *  otherwise. Null when the id doesn't resolve to a workspace (plain-folder
 *  chats) — callers leave their default in place. Never throws. */
export async function resolveWorkspaceTargetRef(
  workspaceId: string,
): Promise<string | null> {
  try {
    const ws = getWorkspaceById(workspaceId);
    if (!ws?.baseBranch || !ws.repoRoot) return null;
    const { remote } = resolveRepoGit(ws.repoRoot);
    const remoteRef = `${remote}/${ws.baseBranch}`;
    return (await refExists(ws.repoRoot, `refs/remotes/${remoteRef}`))
      ? remoteRef
      : ws.baseBranch;
  } catch {
    return null; // a target-branch hiccup must never block an agent spawn
  }
}
