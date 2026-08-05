// ============================================
// COMPONENT: WorkspaceChangeCounts
// PURPOSE: The trailing ± pair on a top-bar workspace tab — everything the
//          branch changed against its base, committed AND uncommitted (the
//          same All Changes comparison the Changes badge counts files for).
// USED IN: TopBar's WorkspaceTab
// ============================================
//
// It sits immediately LEFT of the live-run indicator when both are showing, so
// a running workspace still reports what it changed. Rendering nothing at all
// for a workspace with nothing to report matters more than it looks: the tab is
// content-sized, so an absent pair gives its width back rather than leaving a
// hole. Totals are compacted (formatChangeCount) because the tab caps at 180px
// and the branch name — the only thing allowed to truncate — shares that cap.
//
// Colour follows the run indicator's rule: only the ACTIVE tab spends the
// semantic green/red the rest of the app uses for a diff stat, so a strip of
// twenty workspaces stays monochrome chrome instead of a wall of colour.
//
// Decorative on purpose: a screen reader gets the exact, uncompacted numbers
// from the tab button's own accessible name (workspaceTabDescription).

import { formatChangeCount } from "./workspace-tabs";

// --- TYPES ---

export interface WorkspaceChangeCountsProps {
  /** Added lines across the workspace's whole contribution. */
  additions: number;
  /** Removed lines across the same comparison. */
  deletions: number;
  /** Whether this tab's workspace currently owns the app content. */
  active?: boolean;
}

// --- RENDER ---

export function WorkspaceChangeCounts({
  additions,
  deletions,
  active = false,
}: WorkspaceChangeCountsProps) {
  // Nothing to report renders nothing at all — no zero, no placeholder. This
  // also covers a workspace whose first probe hasn't landed yet.
  if (additions <= 0 && deletions <= 0) return null;
  // Undefined, not a token: an inactive pair inherits the wrapper's fg2 rather
  // than restating it on both halves.
  const addedCls = active ? "text-green-primary" : undefined;
  const removedCls = active ? "text-red-primary" : undefined;
  return (
    <span
      className="text-fg2 text-2xxs shrink-0 tabular-nums"
      data-workspace-change-counts=""
      aria-hidden="true"
    >
      {additions > 0 && (
        <span className={addedCls}>+{formatChangeCount(additions)}</span>
      )}
      {additions > 0 && deletions > 0 && <span> </span>}
      {deletions > 0 && (
        <span className={removedCls}>−{formatChangeCount(deletions)}</span>
      )}
    </span>
  );
}
