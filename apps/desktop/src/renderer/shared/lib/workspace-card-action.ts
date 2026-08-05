import type { Workspace } from "../../platform/git";

/** The single primary action a Dashboard card offers. Derived from the
 *  workspace's git + PR REALITY (and disk presence), NOT its kanban column —
 *  the card button mirrors the workspace header's own state machine.
 *
 *  Ordering matters: `delete` is checked FIRST because a missing worktree
 *  (`present === false`) makes every PR/commit/merge action meaningless — the
 *  folder is gone, so the only thing left to do is drop the orphaned row. */
export type CardActionKind =
  /** Worktree folder deleted on disk (orphaned row) → remove it (branch kept). */
  | "delete"
  /** PR merged or closed → archive the finished workspace. */
  | "archive"
  /** Open PR with uncommitted local work → Commit & Push (opens the workspace). */
  | "commit-push"
  /** Draft PR, clean tree → mark Ready for review (opens the workspace). */
  | "ready-for-review"
  /** Open, non-draft PR, clean tree → Merge. */
  | "merge"
  /** Local changes but no PR yet → Create PR (opens the workspace). */
  | "create-pr"
  /** Nothing done → no button. */
  | null;

/** Resolve the Dashboard card's primary action from a workspace's real state.
 *  Pure + side-effect-free so the state machine can be unit-tested apart from the
 *  React card (which maps the returned kind onto a label/icon/handler). Kept in
 *  lock-step with `DashboardCard` in dashboard-page.tsx.
 *
 *  `hasChanges` is TRI-STATE and passed in (no longer read off `w.hasChanges`,
 *  which came from the now-removed heavy `withChanges` list query): the card
 *  probes dirtiness lazily per-mount. `undefined` means "not yet known" → NO
 *  button, so a dirty open-PR card never flashes a destructive **Merge** while
 *  its change probe is still in flight. */
export function resolveCardActionKind(
  w: Workspace,
  hasChanges: boolean | undefined,
): CardActionKind {
  // Worktree gone (folder deleted out-of-band, row un-archived). Takes priority
  // over any PR/change state — the workspace can't be opened or worked on.
  if (w.present === false) return "delete";
  if (w.prState === "merged" || w.prState === "closed") return "archive";
  // Change probe unresolved → show nothing rather than guess. Critically this
  // prevents an open, non-draft PR whose dirtiness is unknown from offering
  // Merge (which would be wrong if there is uncommitted work).
  if (hasChanges === undefined) return null;
  if (w.prNumber != null) {
    if (hasChanges) return "commit-push";
    if (w.prState === "draft") return "ready-for-review";
    return "merge";
  }
  if (hasChanges) return "create-pr";
  return null;
}
