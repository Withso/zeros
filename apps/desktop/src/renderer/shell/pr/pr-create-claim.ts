// ──────────────────────────────────────────────────────────
// pr-create-claim — remount-safe Create PR action ownership
// ──────────────────────────────────────────────────────────
//
// The PR row unmounts outside Changes/Review, but its access/status preflight
// continues. Claims therefore live at module scope and are keyed by the exact
// workspace id: returning to the row sees the same busy state and cannot queue
// a duplicate brief. Owner identity prevents an old completion from releasing
// a newer action for that workspace.
// ──────────────────────────────────────────────────────────

import {
  claimWorkspaceGitAction, releaseWorkspaceGitAction, workspaceGitActionClaim,
  useWorkspaceGitActionClaim, resetWorkspaceGitActionClaimsForTesting,
  type WorkspaceGitActionClaim,
} from "./workspace-git-action-claims";

export type PrCreateActionClaim = WorkspaceGitActionClaim;

/** Acquire one exact-workspace owner synchronously. */
export function claimPrCreateAction(
  workspaceId: string,
  behavior: "prompt" | "create" = "create",
): PrCreateActionClaim | null {
  return claimWorkspaceGitAction(workspaceId, { kind: "create-pr", behavior });
}

/** Release only the owner that is still current for its workspace. */
export function releasePrCreateAction(owner: PrCreateActionClaim): void {
  releaseWorkspaceGitAction(owner);
}

/** Exact-key snapshot shared by the hook and focused tests. */
export function isPrCreateActionClaimed(workspaceId: string): boolean {
  return workspaceGitActionClaim(workspaceId) != null;
}

/** Remount-safe busy signal for one workspace's Create PR control. */
export function usePrCreateActionClaimed(workspaceId: string): boolean {
  return useWorkspaceGitActionClaim(workspaceId) != null;
}

/** Clear module state between focused tests. */
export function resetPrCreateActionClaimsForTesting(): void {
  resetWorkspaceGitActionClaimsForTesting();
}
