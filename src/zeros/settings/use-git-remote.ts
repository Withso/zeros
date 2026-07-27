// ──────────────────────────────────────────────────────────
// useGitRemote — the repo's effective `git.remote` for UI surfaces
// ──────────────────────────────────────────────────────────
//
// The "Remote origin" setting (repo page → Git) decides where push / pull /
// PR-create point. Engine-side consumers resolve it themselves
// (settings/repo-git.ts); renderer surfaces that TALK about the remote (the
// PR briefs handed to agents, the target-branch label) read it through this
// hook so the words match the behavior. Live: settings writes broadcast
// DB_CHANGED{settings} → useResolvedSettings refetches → the value updates.

import { useResolvedSettings } from "./use-settings";

export const DEFAULT_GIT_REMOTE = "origin";

/** The effective `git.remote` for a repo (default "origin"). Returns the
 *  default until the resolve lands — briefs built in that window match the
 *  engine's own fallback, so they're never *wrong*, just pre-refresh. */
export function useGitRemote(repoRoot: string | undefined): string {
  const { resolved } = useResolvedSettings(repoRoot);
  const git = resolved?.effective?.git;
  if (git && typeof git === "object" && !Array.isArray(git)) {
    const remote = (git as Record<string, unknown>).remote;
    if (typeof remote === "string" && remote.trim()) return remote.trim();
  }
  return DEFAULT_GIT_REMOTE;
}
