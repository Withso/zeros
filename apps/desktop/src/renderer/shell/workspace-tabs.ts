import type { ChangeLineCounts, Workspace } from "../platform/git";
import { branchDisplayName } from "../shared/lib/branch-name";
import { buildLocalMainWorkspace } from "../state/local-main-workspace";
import type { Project } from "../state/projects-store";
import {
  findWorkspaceForFolder,
  workspaceKindFromManagedPath,
  workspaceIdFromWorktreePath,
} from "../state/workspace-resolution";
import { filterWorkspacesForDesignAccess } from "../state/live-workspace-selectors";
import type { WorkspaceNavigationTarget } from "./prefetch-workspace-surface";

export type WorkspacePinSide = "left" | "right" | null;

export interface HorizontalOverflow {
  left: boolean;
  right: boolean;
}

export interface WorkspaceFadeVisibility {
  /** Fade fixed to the strip's physical left edge. */
  outerLeft: boolean;
  /** Fade fixed to the strip's physical right edge. */
  outerRight: boolean;
  /** Fade immediately after an active tab clamped to the left edge. */
  afterPinnedLeft: boolean;
  /** Fade immediately before an active tab clamped to the right edge. */
  beforePinnedRight: boolean;
}

/** A short boundary hairline belongs only between two unselected destinations.
 *  The carrier remains in flow when hidden so selecting a tab never changes
 *  spacing, scroll width, or sticky offsets. */
export function navigationBoundarySeparatorVisible(
  leftActive: boolean,
  rightActive: boolean,
): boolean {
  return !leftActive && !rightActive;
}

/** The workspace to land on when the primary checkout is not an offered
 * destination — the leftmost tab, so "somewhere sensible" matches what the
 * strip shows. Returns null for a cold or worktree-less repo. Shared with the
 * repo-add paths (AddProjectProvider) so a switch and an add agree on where
 * "not the trunk" means. */
export function leftmostLiveWorkspace(
  cachedWorkspaces: readonly Workspace[] | undefined,
): Workspace | null {
  if (!cachedWorkspaces) return null;
  const live = cachedWorkspaces.filter((w) => w.archivedAt == null);
  return orderWorkspaceTabs(live)[0] ?? null;
}

/** Resolve a repository switch without conflating “cache cold” with “there is
 * no remembered workspace”. A confirmed list may invalidate a deleted target;
 * an unresolved list preserves the complete remembered identity immediately.
 *
 * `allowLocalMain` mirrors the "Work in local main" experimental flag. With it
 * off the primary checkout stops being an offered destination: a switch prefers
 * a real worktree instead, so the flag's whole point — never silently putting
 * an agent in the trunk — holds for navigation and not just for the tab strip.
 * Main stays the terminal fallback for a repo with no worktree at all, because
 * there is nowhere else to go; the top bar then shows "+" and no tabs. */
export function resolveRepoWorkspaceDestination(args: {
  project: Project;
  rememberedFolder: string | null | undefined;
  cachedWorkspaces: readonly Workspace[] | undefined;
  allowLocalMain?: boolean;
  allowDesignWorkspaces?: boolean;
}): WorkspaceNavigationTarget {
  const { project, cachedWorkspaces } = args;
  const allowLocalMain = args.allowLocalMain !== false;
  const allowDesignWorkspaces = args.allowDesignWorkspaces !== false;
  const accessibleCachedWorkspaces = cachedWorkspaces
    ? filterWorkspacesForDesignAccess(cachedWorkspaces, allowDesignWorkspaces)
    : undefined;
  const rememberedFolder =
    !allowDesignWorkspaces &&
    workspaceKindFromManagedPath(args.rememberedFolder) === "design"
      ? project.repoRoot
      : args.rememberedFolder || project.repoRoot;
  const main = buildLocalMainWorkspace(project);
  const matched = accessibleCachedWorkspaces
    ? findWorkspaceForFolder(rememberedFolder, accessibleCachedWorkspaces)
    : null;
  if (matched) {
    return matched.path === rememberedFolder
      ? matched
      : { ...matched, path: rememberedFolder };
  }
  if (findWorkspaceForFolder(rememberedFolder, [main])) {
    // The remembered folder is the primary checkout (or a directory below it).
    // A cold list can't prove a worktree exists, so it keeps the remembered
    // identity rather than guessing — the warm case is the one that redirects.
    if (!allowLocalMain) {
      const alternative = leftmostLiveWorkspace(accessibleCachedWorkspaces);
      if (alternative) return alternative;
    }
    return rememberedFolder === project.repoRoot
      ? main
      : { path: rememberedFolder, repoRoot: project.repoRoot };
  }
  if (accessibleCachedWorkspaces === undefined) {
    const workspaceId = workspaceIdFromWorktreePath(rememberedFolder);
    return {
      path: rememberedFolder,
      repoRoot: project.repoRoot,
      ...(workspaceId ? { id: workspaceId } : {}),
      validationPending: true,
    };
  }
  if (!allowLocalMain) {
    const alternative = leftmostLiveWorkspace(accessibleCachedWorkspaces);
    if (alternative) return alternative;
  }
  return main;
}

/** Shown instead of a number once a total no longer fits the two-digit budget
 * below — "there is more of this than the tab can say". */
export const CHANGE_COUNT_OVERFLOW_LABEL = "N";
/** A tab caps at 180px and the branch name has to survive beside the ± pair
 * (and the run wave, when both are showing), so a total gets at most two
 * integer digits and one decimal. 99,950 already rounds to "100.0k" at that
 * precision, which is where the label takes over. */
const CHANGE_COUNT_OVERFLOW_AT = 99_950;

/** Compact a workspace's added/removed line total for a tab.
 *
 *   0…999      → exact ("240")
 *   1_000…     → one decimal, trailing ".0" dropped ("1.5k", "12k", "99.9k")
 *   ≥ 99_950   → CHANGE_COUNT_OVERFLOW_LABEL
 *
 * Non-finite or negative input reads as zero: a tab must never render "NaN"
 * because one engine response arrived malformed. */
export function formatChangeCount(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "0";
  const rounded = Math.round(total);
  if (rounded < 1_000) return String(rounded);
  // The ceiling is judged on what would be PRINTED, not on the raw total: at
  // one decimal, 99_950 already reads "100.0k" and busts the digit budget.
  if (rounded >= CHANGE_COUNT_OVERFLOW_AT) return CHANGE_COUNT_OVERFLOW_LABEL;
  const thousands = Math.round(rounded / 100) / 10;
  return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
}

/** Spell a workspace tab's state out for a screen reader, which can see
 * neither the running-run glyph nor the ± pair beside the branch name. Uses
 * the EXACT totals — the compaction above exists only to fit a 180px tab. */
export function workspaceTabDescription(args: {
  label: string;
  runActionRunning: boolean;
  changeLines: ChangeLineCounts;
}): string {
  const { additions, deletions } = args.changeLines;
  const lines = (count: number) => `${count} line${count === 1 ? "" : "s"}`;
  const parts = [`Open workspace ${args.label}`];
  if (args.runActionRunning) parts.push("run action running");
  if (additions > 0) parts.push(`${lines(additions)} added`);
  if (deletions > 0) parts.push(`${lines(deletions)} removed`);
  return parts.join(", ");
}

const SCROLL_TOLERANCE_PX = 1;

export function workspaceLabel(workspace: Workspace): string {
  return branchDisplayName(workspace.branch);
}

/** Workspace tabs follow creation order: established workspaces remain on the
 * left and every newly-created workspace appends on the right. The engine list
 * is newest-first, so copy before sorting to preserve its bridge-owned array. */
export function orderWorkspaceTabs(
  workspaces: readonly Workspace[],
): Workspace[] {
  const createdAt = (workspace: Workspace) =>
    Number.isFinite(workspace.createdAt)
      ? workspace.createdAt
      : Number.NEGATIVE_INFINITY;

  return [...workspaces].sort(
    (a, b) => createdAt(a) - createdAt(b) || a.id.localeCompare(b.id),
  );
}

/** Resolve which edges still contain hidden horizontal content. Browsers can
 * report fractional scroll positions, so a one-pixel tolerance prevents a
 * fade from flickering at either end of the strip. */
export function horizontalOverflow(args: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}): HorizontalOverflow {
  const maxScrollLeft = Math.max(0, args.scrollWidth - args.clientWidth);
  return {
    left: args.scrollLeft > SCROLL_TOLERANCE_PX,
    right: args.scrollLeft < maxScrollLeft - SCROLL_TOLERANCE_PX,
  };
}

/** Report the edge the active workspace's natural slot crossed. The caller
 * supplies a neighbor-derived natural offset because Chromium exposes a
 * sticky element's clamped visual position through its own `offsetLeft`. */
export function workspacePinSide(args: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  tabOffsetLeft: number;
  tabWidth: number;
  edgeInset?: number;
}): WorkspacePinSide {
  if (args.scrollWidth <= args.clientWidth + SCROLL_TOLERANCE_PX) return null;

  const inset = Math.max(0, args.edgeInset ?? 4);
  const viewportLeft = args.scrollLeft + inset;
  const viewportRight = args.scrollLeft + args.clientWidth - inset;
  if (args.tabOffsetLeft < viewportLeft) return "left";
  if (args.tabOffsetLeft + args.tabWidth > viewportRight) return "right";
  return null;
}

/** Move an externally selected tab's natural slot into view. CSS sticky keeps
 * the active tab visible while scrolling, so `scrollIntoView()` would inspect
 * its clamped visual box and incorrectly decide that an off-screen natural
 * slot is already visible. Offsets avoid that sticky-positioning trap. */
export function workspaceScrollLeftForTab(args: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  tabOffsetLeft: number;
  tabWidth: number;
  edgeInset?: number;
}): number {
  const maxScrollLeft = Math.max(0, args.scrollWidth - args.clientWidth);
  const currentScrollLeft = Math.min(
    maxScrollLeft,
    Math.max(0, args.scrollLeft),
  );
  const inset = Math.max(0, args.edgeInset ?? 4);
  const viewportLeft = currentScrollLeft + inset;
  const viewportRight = currentScrollLeft + args.clientWidth - inset;

  if (args.tabOffsetLeft < viewportLeft) {
    return Math.max(0, Math.min(maxScrollLeft, args.tabOffsetLeft - inset));
  }
  if (args.tabOffsetLeft + args.tabWidth > viewportRight) {
    return Math.max(
      0,
      Math.min(
        maxScrollLeft,
        args.tabOffsetLeft + args.tabWidth - args.clientWidth + inset,
      ),
    );
  }
  return currentScrollLeft;
}

/** The fade at a pinned edge relocates to the inside edge of the active tab.
 * The opposite outer fade remains available when that edge still has hidden
 * content. Keeping this decision pure makes the scroll handler a synchronous
 * DOM update instead of a React render loop. */
export function workspaceFadeVisibility(
  overflow: HorizontalOverflow,
  pinSide: WorkspacePinSide,
): WorkspaceFadeVisibility {
  return {
    outerLeft: overflow.left && pinSide !== "left",
    outerRight: overflow.right && pinSide !== "right",
    afterPinnedLeft: overflow.left && pinSide === "left",
    beforePinnedRight: overflow.right && pinSide === "right",
  };
}

function normalizeSearchValue(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Repo-scope, search, and order the archive popover without mutating the
 * bridge-owned array. Archived state is checked defensively so a stale or
 * malformed engine response can never duplicate a live tab in this surface. */
export function filterArchivedWorkspaces(
  workspaces: readonly Workspace[],
  repoSlug: string,
  query: string,
): Workspace[] {
  const terms = normalizeSearchValue(query.trim()).split(/\s+/).filter(Boolean);

  return workspaces
    .filter((workspace) => {
      if (
        workspace.repoSlug !== repoSlug ||
        typeof workspace.archivedAt !== "number" ||
        !Number.isFinite(workspace.archivedAt)
      )
        return false;
      if (terms.length === 0) return true;
      const haystack = normalizeSearchValue(
        [workspaceLabel(workspace), workspace.branch, workspace.baseBranch]
          .filter(Boolean)
          .join(" "),
      );
      return terms.every((term) => haystack.includes(term));
    })
    .sort(
      (a, b) =>
        (b.archivedAt ?? 0) - (a.archivedAt ?? 0) ||
        b.createdAt - a.createdAt ||
        a.id.localeCompare(b.id),
    );
}
