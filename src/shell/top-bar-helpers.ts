import type { Workspace } from "../native/git";
import { buildLocalMainWorkspace } from "../zeros/store/local-main-workspace";
import type { Project } from "../zeros/store/projects-store";
import {
  findWorkspaceForFolder,
  workspaceIdFromWorktreePath,
} from "../zeros/store/workspace-resolution";
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

/** Resolve a repository switch without conflating “cache cold” with “there is
 * no remembered workspace”. A confirmed list may invalidate a deleted target;
 * an unresolved list preserves the complete remembered identity immediately. */
export function resolveRepoWorkspaceDestination(args: {
  project: Project;
  rememberedFolder: string | null | undefined;
  cachedWorkspaces: readonly Workspace[] | undefined;
}): WorkspaceNavigationTarget {
  const { project, cachedWorkspaces } = args;
  const rememberedFolder = args.rememberedFolder || project.repoRoot;
  const main = buildLocalMainWorkspace(project);
  const matched = cachedWorkspaces
    ? findWorkspaceForFolder(rememberedFolder, [...cachedWorkspaces])
    : null;
  if (matched) {
    return matched.path === rememberedFolder
      ? matched
      : { ...matched, path: rememberedFolder };
  }
  if (findWorkspaceForFolder(rememberedFolder, [main])) {
    return rememberedFolder === project.repoRoot
      ? main
      : { path: rememberedFolder, repoRoot: project.repoRoot };
  }
  if (cachedWorkspaces === undefined) {
    const workspaceId = workspaceIdFromWorktreePath(rememberedFolder);
    return {
      path: rememberedFolder,
      repoRoot: project.repoRoot,
      ...(workspaceId ? { id: workspaceId } : {}),
      validationPending: true,
    };
  }
  return main;
}

const SCROLL_TOLERANCE_PX = 1;

export function workspaceLabel(workspace: Workspace): string {
  return workspace.branch.startsWith("zeros/")
    ? workspace.branch.slice("zeros/".length)
    : workspace.branch;
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
