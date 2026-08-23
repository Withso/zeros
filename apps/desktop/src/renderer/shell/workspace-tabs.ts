import type { ChangeLineCounts, Workspace } from "../platform/git";
import { branchDisplayName } from "../shared/lib/branch-name";
import { buildLocalMainWorkspace } from "../state/local-main-workspace";
import type { Project } from "../state/projects-store";
import {
  findWorkspaceForFolder,
  workspaceIdFromWorktreePath,
} from "../state/workspace-resolution";
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
}): WorkspaceNavigationTarget {
  const { project, cachedWorkspaces } = args;
  const allowLocalMain = args.allowLocalMain !== false;
  const accessibleCachedWorkspaces = cachedWorkspaces;
  const rememberedFolder = args.rememberedFolder || project.repoRoot;
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

/** A sticky element can carry a DIFFERENT inset at each edge, and the pin
 * decision has to use the same pair the CSS does or the reported side flips a
 * few pixels early or late. `edgeInset` remains the symmetric shorthand; the
 * Grouped lane overrides `leadingInset` alone, because its pinned pill reserves
 * the repository lead's slot on the left and still lands flush on the right. */
function stickyInsets(args: {
  edgeInset?: number;
  leadingInset?: number;
  trailingInset?: number;
}): { leading: number; trailing: number } {
  const shared = Math.max(0, args.edgeInset ?? 4);
  return {
    leading: Math.max(0, args.leadingInset ?? shared),
    trailing: Math.max(0, args.trailingInset ?? shared),
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
  leadingInset?: number;
  trailingInset?: number;
}): WorkspacePinSide {
  if (args.scrollWidth <= args.clientWidth + SCROLL_TOLERANCE_PX) return null;

  const inset = stickyInsets(args);
  const viewportLeft = args.scrollLeft + inset.leading;
  const viewportRight = args.scrollLeft + args.clientWidth - inset.trailing;
  if (args.tabOffsetLeft < viewportLeft) return "left";
  if (args.tabOffsetLeft + args.tabWidth > viewportRight) return "right";
  return null;
}

/** The sticky `right` inset that parks a pinned repository lead immediately
 * before the pinned pill: the pill's own trailing inset, plus the pill, plus
 * the carrier between them. Pure so the one number CSS and the fade placement
 * both depend on cannot drift between them. */
export function workspacePinnedLeadTrailingInset(args: {
  edgeInset: number;
  tabWidth: number;
  gap: number;
}): number {
  return (
    Math.max(0, args.edgeInset) +
    Math.max(0, args.tabWidth) +
    Math.max(0, args.gap)
  );
}

/** Where the two relocated fades sit once something has parked at that edge.
 *
 * Each edge is charged for ONLY what parked at THAT edge. The pill and its
 * repository lead can legitimately split across both — a long repository whose
 * icon has already reached the leading edge while its selection is still parked
 * at the trailing one — and charging the trailing fade for a lead pinned at the
 * leading edge would strand a lead-slot of unfaded content beside the pill. */
export function workspacePinnedFadeOffsets(args: {
  clientWidth: number;
  tabWidth: number;
  edgeInset: number;
  leadSlot: number;
  fadeWidth: number;
  pinSide: WorkspacePinSide;
  leadPinSide: WorkspacePinSide;
}): { afterPinnedLeft: number; beforePinnedRight: number } {
  const leadingLead = args.leadPinSide === "left" ? args.leadSlot : 0;
  const trailingLead = args.leadPinSide === "right" ? args.leadSlot : 0;
  return {
    afterPinnedLeft:
      args.edgeInset +
      leadingLead +
      (args.pinSide === "left" ? args.tabWidth : 0),
    beforePinnedRight: Math.max(
      0,
      args.clientWidth -
        args.edgeInset -
        (args.pinSide === "right" ? args.tabWidth : 0) -
        trailingLead -
        args.fadeWidth,
    ),
  };
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
  leadingInset?: number;
  trailingInset?: number;
}): number {
  const maxScrollLeft = Math.max(0, args.scrollWidth - args.clientWidth);
  const currentScrollLeft = Math.min(
    maxScrollLeft,
    Math.max(0, args.scrollLeft),
  );
  const inset = stickyInsets(args);
  const viewportLeft = currentScrollLeft + inset.leading;
  const viewportRight = currentScrollLeft + args.clientWidth - inset.trailing;

  // Land the natural slot ON the sticky inset, not merely inside the viewport:
  // stopping short of it would leave CSS sticky pushing the revealed tab off
  // its own flow position and over the neighbour beside it.
  if (args.tabOffsetLeft < viewportLeft) {
    return Math.max(
      0,
      Math.min(maxScrollLeft, args.tabOffsetLeft - inset.leading),
    );
  }
  if (args.tabOffsetLeft + args.tabWidth > viewportRight) {
    return Math.max(
      0,
      Math.min(
        maxScrollLeft,
        args.tabOffsetLeft + args.tabWidth - args.clientWidth + inset.trailing,
      ),
    );
  }
  return currentScrollLeft;
}

/** The fade at a pinned edge relocates to the inside edge of the active tab.
 * The opposite outer fade remains available when that edge still has hidden
 * content. Keeping this decision pure makes the scroll handler a synchronous
 * DOM update instead of a React render loop.
 *
 * `leadPinSide` is the Grouped lane's repository lead, resolved against its own
 * insets and therefore genuinely independent of the pill's: it reaches the LEFT
 * edge first when its selection sits deeper in the same repository, and a long
 * enough repository can hold the two at OPPOSITE edges. So an edge counts as
 * pinned if EITHER parked there — an outer fade would otherwise sit under the
 * opaque lead and leave the content emerging beside it with a hard cut. */
export function workspaceFadeVisibility(
  overflow: HorizontalOverflow,
  pinSide: WorkspacePinSide,
  leadPinSide: WorkspacePinSide = null,
): WorkspaceFadeVisibility {
  const pinnedLeft = pinSide === "left" || leadPinSide === "left";
  const pinnedRight = pinSide === "right" || leadPinSide === "right";
  return {
    outerLeft: overflow.left && !pinnedLeft,
    outerRight: overflow.right && !pinnedRight,
    afterPinnedLeft: overflow.left && pinnedLeft,
    beforePinnedRight: overflow.right && pinnedRight,
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
