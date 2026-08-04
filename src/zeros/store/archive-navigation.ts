import type { Workspace } from "../../native/git";

/** Stable top-bar order without importing renderer chrome into store actions. */
function compareWorkspaceOrder(a: Workspace, b: Workspace): number {
  const createdAt = (workspace: Workspace) =>
    Number.isFinite(workspace.createdAt)
      ? workspace.createdAt
      : Number.NEGATIVE_INFINITY;
  return createdAt(a) - createdAt(b) || a.id.localeCompare(b.id);
}

/** Pick the nearest still-live workspace to the LEFT of `leaving` in the
 * top-bar's creation order. The main checkout is intentionally not represented
 * here: null means the caller should use its main/dashboard fallback.
 *
 * Busy rows are skipped so a burst of archive clicks cannot navigate onto a
 * workspace that is itself disappearing. We do not fall rightward when the
 * first worktree leaves; the synthetic main tab is immediately to its left. */
export function previousWorkspaceInOrder(
  leaving: Workspace,
  rows: readonly Workspace[],
  busyIds: Readonly<Record<string, number>>,
  options: { allowDesignWorkspaces?: boolean } = {},
): Workspace | null {
  const allowDesignWorkspaces = options.allowDesignWorkspaces !== false;
  // A server-state refresh can publish the confirmed archived list immediately
  // before the archive response continuation performs its atomic navigation
  // commit. Reinsert the known leaving identity for ordering only so that race
  // still selects its real predecessor instead of incorrectly falling to main.
  const orderedRows = rows.some((workspace) => workspace.id === leaving.id)
    ? rows
    : [...rows, leaving];
  const ordered = [
    ...orderedRows.filter(
      (workspace, index) =>
        workspace.repoSlug === leaving.repoSlug &&
        orderedRows.findIndex((candidate) => candidate.id === workspace.id) ===
          index,
    ),
  ].sort(compareWorkspaceOrder);
  const leavingIndex = ordered.findIndex(
    (workspace) => workspace.id === leaving.id,
  );
  if (leavingIndex < 0) return null;
  for (let index = leavingIndex - 1; index >= 0; index -= 1) {
    const candidate = ordered[index];
    if (
      candidate.archivedAt == null &&
      candidate.present !== false &&
      (allowDesignWorkspaces || candidate.kind !== "design") &&
      candidate.path !== leaving.path &&
      !(candidate.id in busyIds)
    ) {
      return candidate;
    }
  }
  return null;
}
