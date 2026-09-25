// ──────────────────────────────────────────────────────────
// Live-workspace selectors (the ONE filter/count path)
// ──────────────────────────────────────────────────────────
//
// Every surface that lists live (non-archived) workspaces — the top-bar strip,
// the Dashboard board, the repo hub list, and the home-sidebar repo counts —
// reads the SAME per-repo `workspaceCache` rows (unioned for cross-repo views)
// and projects them through these helpers. Local archive intent hides its row
// immediately; the confirmed cache changes only after the engine finishes.
// Clearing a failed intent reveals the newest confirmed row without rollback
// writes that could clobber a concurrent update.
// ──────────────────────────────────────────────────────────

import { useMemo } from "react";
import type { Workspace } from "../platform/git";
import {
  usePendingWorkspacesStore,
  type PendingWorkspaceCreate,
} from "./pending-workspaces";

const EMPTY_PENDING: PendingWorkspaceCreate[] = [];
const EMPTY_ARCHIVE_INTENTS: Readonly<Record<string, number>> = {};

/** Available workspaces only. Missing records remain in the cache and appear
 * alongside archives in history. Preserve references on unchanged reads. */
export function selectLiveVisible(
  rows: readonly Workspace[],
  archiveIntents: Readonly<Record<string, number>> = EMPTY_ARCHIVE_INTENTS,
): Workspace[] {
  let anyFiltered = false;
  const out: Workspace[] = [];
  for (const w of rows) {
    if (w.archivedAt != null || w.present === false || w.id in archiveIntents) {
      anyFiltered = true;
      continue;
    }
    out.push(w);
  }
  return anyFiltered ? out : (rows as Workspace[]);
}

/** Shared presentation subscription for tabs, Dashboard, and repository rows. */
export function useLiveVisible(rows: readonly Workspace[]): Workspace[] {
  const archiveIntents = usePendingWorkspacesStore(
    (state) => state.archiveIntents,
  );
  return useMemo(
    () => selectLiveVisible(rows, archiveIntents),
    [rows, archiveIntents],
  );
}

/** Drop any pending create whose reserved branch (fallback: path) already
 *  appears as a real row — the moment the real workspace lands, its
 *  "Setting up…" placeholder must vanish rather than double-render.
 *
 *  A branch match only counts WITHIN the pending create's own repository. The
 *  engine allocates workspace names from a per-repository free set of colour
 *  words (git/naming.ts), so two repositories routinely hold the same branch,
 *  and the DB's uniqueness index is (repo_slug, branch) for exactly that
 *  reason. Matching branches globally would let an unrelated repository that
 *  already owns that colour erase a brand-new workspace's placeholder — the
 *  one frame the optimistic create exists to guarantee — for every caller that
 *  passes the cross-repository union (top bar, Dashboard, archive repoint).
 *  Paths are absolute and therefore remain a global identity. */
export function dedupePendingCreates(
  pending: readonly PendingWorkspaceCreate[],
  realRows: readonly Workspace[],
): PendingWorkspaceCreate[] {
  if (pending.length === 0) return EMPTY_PENDING;
  const branchesBySlug = new Map<string, Set<string>>();
  const paths = new Set<string>();
  for (const w of realRows) {
    const branches = branchesBySlug.get(w.repoSlug);
    if (branches) branches.add(w.branch);
    else branchesBySlug.set(w.repoSlug, new Set([w.branch]));
    paths.add(w.path);
  }
  return pending.filter((p) => {
    if (p.branch && branchesBySlug.get(p.repoSlug)?.has(p.branch)) return false;
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
  archiveIntents: Readonly<Record<string, number>> = EMPTY_ARCHIVE_INTENTS,
): Map<string, number> {
  const bySlug = new Map<string, Workspace[]>();
  for (const w of rows) {
    const list = bySlug.get(w.repoSlug);
    if (list) list.push(w);
    else bySlug.set(w.repoSlug, [w]);
  }
  const counts = new Map<string, number>();
  for (const [slug, slugRows] of bySlug) {
    counts.set(slug, selectLiveVisible(slugRows, archiveIntents).length);
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
