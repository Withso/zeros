// ──────────────────────────────────────────────────────────
// Live-workspace selectors (the ONE filter/count path)
// ──────────────────────────────────────────────────────────
//
// Every surface that lists live (non-archived) workspaces — the top-bar strip,
// the Dashboard board, the repo hub list, and the home-sidebar repo counts —
// reads the SAME per-repo `workspaceCache` rows (unioned for cross-repo views)
// and projects them through these pure helpers. A destructive operation does
// not change membership: its row remains in place with a busy affordance until
// the authoritative cache transition confirms archive/delete. That prevents a
// failed operation from making the workspace disappear and then bounce back.
// ──────────────────────────────────────────────────────────

import type { Workspace } from "../platform/git";
import type { PendingWorkspaceCreate } from "./pending-workspaces";

const EMPTY_PENDING: PendingWorkspaceCreate[] = [];

/** Under the mode model (one workspace, two modes) design-MODE rows are
 * ordinary workspaces and are NEVER hidden: hiding them when the Internal
 * flag is off would strand a real worktree with no way to archive it or
 * switch it back to code mode. What the flag gates is the design SURFACE —
 * a blocked route mounts the "design mode is disabled" placeholder (see
 * shell/design-workspace-access.ts), whose exit action is deliberately
 * un-gated. Kept as a pass-through (same signature) so the many call sites
 * and their memo inputs stay untouched; retired entirely once the flag
 * graduates. */
export function filterWorkspacesForDesignAccess(
  rows: readonly Workspace[],
  _designWorkspacesActive: boolean,
): Workspace[] {
  return rows as Workspace[];
}

/** Same pass-through as above for in-flight creates: a pending design create
 * is a real create (the row lands moments later), so hiding its "Setting up"
 * tab would make the workspace pop into existence unexplained. Creating in
 * design mode is already flag-gated at the entry point (create-workspace.ts),
 * so a pending design create implies the flag was on moments ago. */
export function filterPendingCreatesForDesignAccess(
  rows: readonly PendingWorkspaceCreate[],
  _designWorkspacesActive: boolean,
): PendingWorkspaceCreate[] {
  return rows as PendingWorkspaceCreate[];
}

/** The single visibility filter: drop only rows the server has confirmed
 * archived. Deliberately KEEPS `present === false` (orphaned worktree) rows so
 * every surface's SET — and therefore its count — agrees; each surface still
 * HANDLES present===false in its own rendering (Dashboard → "Worktree missing"
 * card, top-bar/repo rows → open the WorktreeMissingPanel). Returns the input
 * array unchanged when nothing is filtered, so referential identity is
 * preserved for memo bailout. */
export function selectLiveVisible(rows: readonly Workspace[]): Workspace[] {
  let anyFiltered = false;
  const out: Workspace[] = [];
  for (const w of rows) {
    if (w.archivedAt != null) {
      anyFiltered = true;
      continue;
    }
    out.push(w);
  }
  return anyFiltered ? out : (rows as Workspace[]);
}

/** Drop any pending create whose reserved branch (fallback: path) already
 *  appears as a real row — the moment the real workspace lands, its
 *  "Setting up…" placeholder must vanish rather than double-render. Mirrors the
 *  top bar's existing branch-based dedup. */
export function dedupePendingCreates(
  pending: readonly PendingWorkspaceCreate[],
  realRows: readonly Workspace[],
): PendingWorkspaceCreate[] {
  if (pending.length === 0) return EMPTY_PENDING;
  const branches = new Set<string>();
  const paths = new Set<string>();
  for (const w of realRows) {
    branches.add(w.branch);
    paths.add(w.path);
  }
  return pending.filter((p) => {
    if (p.branch && branches.has(p.branch)) return false;
    if (p.path && paths.has(p.path)) return false;
    return true;
  });
}

/** Per-repo live count = live-visible rows + deduped pending creates, computed
 *  by the SAME functions every surface uses so the top-bar tab count, the
 *  Dashboard per-repo card count, and the sidebar badge can never diverge —
 *  including during the optimistic create window. */
export function countLiveVisibleBySlug(
  rows: readonly Workspace[],
  allPending: readonly PendingWorkspaceCreate[],
): Map<string, number> {
  const bySlug = new Map<string, Workspace[]>();
  for (const w of rows) {
    const list = bySlug.get(w.repoSlug);
    if (list) list.push(w);
    else bySlug.set(w.repoSlug, [w]);
  }
  const counts = new Map<string, number>();
  for (const [slug, slugRows] of bySlug) {
    counts.set(slug, selectLiveVisible(slugRows).length);
  }
  const pendingBySlug = new Map<string, PendingWorkspaceCreate[]>();
  for (const p of allPending) {
    const list = pendingBySlug.get(p.repoSlug);
    if (list) list.push(p);
    else pendingBySlug.set(p.repoSlug, [p]);
  }
  for (const [slug, slugPending] of pendingBySlug) {
    const deduped = dedupePendingCreates(slugPending, bySlug.get(slug) ?? []);
    if (deduped.length > 0) {
      counts.set(slug, (counts.get(slug) ?? 0) + deduped.length);
    }
  }
  return counts;
}
