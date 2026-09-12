// ============================================
// COMPONENT: TopBar
// PURPOSE: Global project and workspace navigation after removing Repository panel.
// USED IN: MainShellBody (workspace, Home sub-pages [Dashboard + Settings],
//          missing-worktree, and welcome views)
// ============================================

// --- IMPORTS ---

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Archive,
  Check,
  ClipboardList,
  GitBranch,
  GitMerge,
  GitMergeConflict,
  GitPullRequestArrow,
  GitPullRequestClosed,
  Home,
  ImageIcon,
  LaptopMinimal,
  ListFilter,
  MessageCircleQuestionMark,
  PenTool,
  Plus,
  Settings,
} from "lucide-react";

import { type Workspace } from "../platform/git";
import { usePrIslandKind } from "./pr/pr-island-state-store";
import { useNativeRuntime } from "../platform/runtime";
import { trackWorkspaceOpened } from "../platform/observability/analytics/agent-events";
import { useAgentSessions } from "../features/agent/sessions-hooks";
import {
  useAnyChatAwaitingKind,
  useAnyChatAgentWorking,
} from "../features/agent/sessions-store";
import {
  isLocalMainWorkspace,
  LOCAL_MAIN_LABEL,
  withLocalMainWorkspace,
} from "../state/local-main-workspace";
import {
  pruneWorktreePhantomProjects,
  type Project,
} from "../state/projects-store";
import { DEFAULT_REPO_SETTINGS_VIEW } from "../features/repositories/repo-page";
import {
  selectActiveFolder,
  selectChatToRestoreForFolder,
  selectLastWorkspaceFolderForRepo,
  useActivePage,
  useCreateWorkspaceProjectId,
  useActiveRepoId,
  useChats,
  useWorkspaceActivityByFolder,
  useWorkspaceListFilter,
  useWorkspaceDispatch,
  useWorkspaceStore,
} from "../state/store";
import {
  restoreWorkspaceWithFeedback,
  useArchiveWorkspace,
} from "../state/archive-actions";
import { useOpenWorkspace } from "../state/use-open-workspace";
import {
  notifyProjectsChanged,
  peekWorkspacesFor,
  prefetchWorkspacesFor,
  useArchivedWorkspaces,
  useLiveWorkspaces,
  useProjects,
  useSyncProjectsToEngine,
  useWorkspacesFor,
} from "../state/use-projects";
import {
  dedupePendingCreates,
  selectLiveVisible,
} from "../state/live-workspace-selectors";
import {
  prefetchSettingsForRepo,
  usePrefetchSettings,
} from "../features/settings/use-settings";
import {
  findProjectForFolder,
  findWorkspaceForFolder,
} from "../state/workspace-resolution";
import { Button } from "../shared/ui/primitives/button";
import {
  Command,
  CommandInput,
  CommandList,
} from "../shared/ui/primitives/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../shared/ui/primitives/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../shared/ui/primitives/context-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../shared/ui/primitives/popover";
import {
  isExperimentalEnabled,
  useExperimentalFeature,
} from "../features/settings/experimental-features";
import { useActiveOrganization } from "../features/team/team-store";
import { filterRowsForOrganization } from "../features/team/organization-capabilities";
import { toast } from "../shared/ui/primitives/elements";
import { Tooltip } from "../shared/ui/primitives/tooltip";
import { RepositoryIcon } from "../features/repositories/repository-icon";
import { WorkspaceContextMenu } from "../shared/ui/workspace-context-menu";
import { formatCompactAge } from "../features/agent/format-age";
import { RunWave, ZerosSpinner } from "../shared/ui/loading";
import { useAddProject } from "./add-project-provider";
import {
  useAnyRunActionRunning,
  useWorkspaceRunActivitySync,
} from "./terminal/run-activity-store";
import {
  usePendingCreatesAll,
  type PendingWorkspaceCreate,
  usePendingWorkspaceMode,
  useWorkspaceArchiving,
  useWorkspaceProvisioning,
} from "../state/pending-workspaces";
import { prefetchWorkspaceSurface } from "./prefetch-workspace-surface";
import { prepareChatView } from "./conversation/chat-intent";
import { warmWorkspaceFiles } from "./workspace-files-cache";
import { RepositoryIconDialog } from "./repository-icon-dialog";
import {
  filterArchivedWorkspaces,
  horizontalOverflow,
  navigationBoundarySeparatorVisible,
  resolveRepoWorkspaceDestination,
  workspaceFadeVisibility,
  workspaceLabel,
  workspacePinnedFadeOffsets,
  workspacePinnedLeadTrailingInset,
  workspacePinSide,
  workspaceScrollLeftForTab,
  workspaceTabDescription,
  type WorkspacePinSide,
} from "./workspace-tabs";
import { branchDisplayName } from "../shared/lib/branch-name";
import { useCustomWindowDrag } from "./use-custom-window-drag";
import { useWorkspaceChangeLines } from "./use-workspace-change-lines";
import { WorkspaceChangeCounts } from "./workspace-change-counts";
import { ResourceMonitor } from "./resource-monitor";
import { cn } from "../shared/ui/cn";
import {
  effectiveWorkspaceListFilter,
  isMixedWorkspaceListFilter,
  repositoryWorkspaceListFilter,
  workspaceActivityTimestamp,
  workspaceListFilterProjectId,
  workspaceTabGroups,
  type WorkspaceListFilter,
  type WorkspaceTabActivity,
} from "../state/workspace-list-filter";

// --- CONSTANTS ---

/** Warm the exact workspace a repository switch will restore. This works even
 * while the repository's workspace-list key is cold because the persisted
 * folder itself is already a complete local navigation identity. */
function prefetchProjectWorkspaceDestination(project: Project): void {
  prefetchWorkspacesFor(project.repoSlug);
  const state = useWorkspaceStore.getState();
  prefetchWorkspaceSurface(
    resolveRepoWorkspaceDestination({
      project,
      rememberedFolder: selectLastWorkspaceFolderForRepo(
        state,
        project.repoRoot,
      ),
      cachedWorkspaces: peekWorkspacesFor(project.repoSlug),
      // Synchronous read: this warms the cache from a plain event handler, and
      // it must agree with the destination handleSelectFilter will pick.
      allowLocalMain: isExperimentalEnabled("workInLocalMain"),
    }),
  );
}

// Top-bar destinations use the same inset, borderless geometry as the app's
// other navigation strips: 28px controls centered in the fixed 40px title bar,
// with six pixels of vertical breathing room and an opaque rounded selection
// instead of full-height divided cells.
const ICON_BUTTON_CLS =
  "h-7 w-7 shrink-0 rounded-md text-fg2 hover:bg-sidebar-bg-hover hover:text-fg1 data-[active=true]:bg-sidebar-bg-hover data-[active=true]:text-fg1 data-[active=true]:hover:bg-sidebar-bg-hover";
// The archived picker's `data-active` means its popover is open rather than a
// durable route selection, but it uses the same temporary rounded fill.
const MENU_ICON_BUTTON_CLS =
  "h-7 w-7 shrink-0 rounded-md text-fg2 hover:bg-sidebar-bg-hover hover:text-fg1 data-[active=true]:bg-sidebar-bg-hover data-[active=true]:text-fg1";
// Main is a named destination and follows the workspace pill metrics.
const MAIN_TAB_CLS =
  "h-7 shrink-0 justify-start gap-2.5 rounded-md px-2.5 text-xs text-fg2 transition-none hover:bg-sidebar-bg-hover hover:text-fg1 data-[active=true]:bg-sidebar-bg-hover data-[active=true]:text-fg1 data-[active=true]:hover:bg-sidebar-bg-hover [&_svg]:size-3.5";
// The app window bottoms out at 800px. Interpolate through the constrained
// 800–1200px band, then hold the requested default/max widths above it.
const PROJECT_TRIGGER_CLS =
  "h-7 w-[clamp(100px,calc(10vw_+_20px),140px)] min-w-[100px] max-w-[140px] shrink-0 justify-start gap-2 rounded-md border-0 bg-transparent px-2.5 text-xs text-fg2 shadow-none hover:bg-sidebar-bg-hover hover:text-fg1 data-[state=open]:bg-sidebar-bg-hover data-[state=open]:text-fg1";
const PROJECT_CHIP_CLS =
  "inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-bg2-hover text-xxs font-medium text-fg2";
// Content-sized, not a fixed ramp: the tab is as wide as its icon + name +
// whatever trailing indicators it happens to carry, floored at 120px and capped
// at 180px. NO `w-*` — a width would defeat the intrinsic sizing, and every
// child except the name is shrink-0, so the cap spends itself truncating the
// branch name and never the ± pair or the wave.
// The selected workspace is an opaque rounded pill. Its four-pixel sticky inset
// mirrors the lane gutters so it retains breathing room at either overflow edge.
// The label weight lives HERE, on the container both tab variants share, not
// on the inner Button — `buttonVariants` bakes in `font-medium`, so a real tab
// got 500 while the pending placeholder (a bare div, no Button) inherited the
// body's 400 and visibly thickened the moment the create landed. Declaring it
// once on the shared class is what the chat strip does (TAB_BASE_CLS in
// conversation/chat-tabs.tsx) and is why that strip has never had the same snap.
const WORKSPACE_TAB_CLS =
  "group/workspace relative flex h-7 min-w-[120px] max-w-[180px] shrink-0 select-none items-center overflow-hidden rounded-md px-2.5 text-left text-xs font-medium text-fg2 transition-none focus-within:bg-sidebar-bg-hover focus-within:text-fg2 data-[hovered=true]:bg-sidebar-bg-hover data-[hovered=true]:text-fg2 data-[active=true]:sticky data-[active=true]:left-1 data-[active=true]:right-1 data-[active=true]:z-20 data-[active=true]:bg-sidebar-bg-hover data-[active=true]:text-fg1 data-[active=true]:focus-within:text-fg1 data-[active=true]:data-[hovered=true]:text-fg1";
// Once pinned, the selected pill floats over whichever tabs keep scrolling
// underneath it. A two-pixel bar-coloured ring is the inward breathing room at
// either edge and, because it paints behind the rounded box without affecting
// layout, also prevents a Grouped surface or its border-y hairline from showing
// through the pill's transparent corner pixels. Its outward half simply merges
// into the existing four-pixel opaque viewport gutter. This stays shared across
// Grouped, Ungrouped, Active and repository-only lanes.
const WORKSPACE_PINNED_EDGE_CLS =
  "group-data-[workspace-pin]/lane:data-[active=true]:ring-2 group-data-[workspace-pin]/lane:data-[active=true]:ring-sidebar-bg";
// Grouped rows keep every repository segment on one continuous, 50%-opaque
// bg2 surface. Only the outer perimeter receives the translucent border2
// outline, so workspace boundaries never turn into internal divider seams.
// The root stays square between items; a separate rounded state layer lets
// hover and selection use the exact same fill without punching holes in that
// surface at the tab's corners.
const GROUPED_REPOSITORY_ITEM_CLS =
  "isolate rounded-none border-y border-border2/50 bg-bg2/50 focus-within:bg-bg2/50 data-[hovered=true]:bg-bg2/50 data-[active=true]:bg-bg2/50";
const GROUPED_WORKSPACE_STATE_CLS =
  "pointer-events-none absolute inset-0 -z-10 rounded-md bg-sidebar-bg-hover opacity-0 group-focus-within/workspace:opacity-100 group-data-[hovered=true]/workspace:opacity-100 group-data-[active=true]/workspace:opacity-100";
const GROUPED_PROJECT_MARKER_CLS =
  "group/project relative isolate rounded-l-md rounded-r-none border-y border-l border-border2/50 bg-bg2/50 hover:bg-bg2/50 data-[active=true]:bg-bg2/50";
const GROUPED_PROJECT_STATE_CLS =
  "pointer-events-none absolute inset-0 -z-10 rounded-md bg-sidebar-bg-hover opacity-0 group-hover/project:opacity-100 group-focus-visible/project:opacity-100";
// ── Grouped mode, pinned at an overflow edge ──────────────
//
// A pinned pill has LEFT its repository: the surface it capped, the icon that
// named it, and the neighbours its square edges bridged to are all scrolled
// away. So the group treatment comes off and the pair reverts to the same
// borderless opaque selection every other lane pins — a plain repository icon
// beside a rounded selected pill — instead of a square, half-transparent
// fragment of a group floating at the edge.
//
// Written imperatively from the scroll-synchronous measure pass, because CSS
// cannot yet ask whether a sticky element is stuck — but written onto THE LANE
// (WORKSPACE_PIN_ATTR), never onto the pill itself. The pill is a React-owned
// node that remounts, reorders and re-registers its ref on any of a dozen
// unrelated updates; a marker written to whatever a ref map happened to hold
// can end up on a node that is no longer the one on screen, and then the pinned
// pill silently keeps its group treatment. The lane is one element that lives
// as long as the strip, so the marker cannot miss it, and `data-active` on the
// tab picks out which pill it applies to.
//
// Every selector is DELIBERATELY doubled — the lane's marker plus the tab's own
// `data-[active=true]` is (0,3,0), which is what it takes to outrank the
// single-variant grouped fills above. A single-variant override would tie with
// `data-[active=true]:bg-bg2/50` and be settled by Tailwind's emission order.
const GROUPED_PINNED_WORKSPACE_CLS =
  "group-data-[workspace-pin]/lane:data-[active=true]:rounded-md group-data-[workspace-pin]/lane:data-[active=true]:border-0 group-data-[workspace-pin]/lane:data-[active=true]:bg-sidebar-bg-hover";
// Retire the Grouped surface underneath the selected pill itself. This square,
// bar-coloured layer sits at `-z-20`, below the rounded state layer at `-z-10`;
// every other tab keeps the repository surface it genuinely sits on. The root's
// overflow clips this mask at its own radius, so WORKSPACE_PINNED_EDGE_CLS owns
// the separate job of clearing the transparent corner pixels and the two-pixel
// inward gap outside that clip.
const GROUPED_PINNED_WORKSPACE_MASK_CLS =
  "pointer-events-none absolute inset-0 -z-20 hidden bg-sidebar-bg group-data-[workspace-pin]/lane:block";
// The pill's own sticky inset in Grouped mode. It reserves the repository
// lead's slot at the leading edge — the lead has nowhere to go if the pill
// itself occupies the four-pixel inset — and keeps `right-1` from
// WORKSPACE_TAB_CLS, because at the trailing edge the lead overlays the tabs
// BEHIND the pill and needs no reservation. Mirrors
// WORKSPACE_GROUPED_LEADING_INSET_PX.
const GROUPED_WORKSPACE_STICKY_INSET_CLS = "data-[active=true]:left-9";
// The selected workspace's repository icon travels with it: sticky at the same
// two edges, one carrier ahead of the pill. `right` is JS-published because it
// depends on the pill's content-sized width, and its fallback is `auto` — no
// trailing stickiness at all — so a frame before the first measurement degrades
// to "does not pin yet" instead of pinning at the wrong inset, on top of the
// pill. `z-20` only WHILE pinned: an unpinned lead is ordinary lane content and
// must keep fading under the overflow gradients (z-10) like the tabs around it.
// `transition-none` is load-bearing, not tidying: the lead is a Button, and the
// primitive's base `transition-colors` cross-fades background-color over 150ms.
// Pinning swaps the half-transparent group surface for the opaque mask below,
// so a fade means six frames of tabs scrolling THROUGH the pinned icon while
// the radius beside it has already snapped. The workspace pills next to it are
// `transition-none` for the same reason.
// `border-0` retires the group cap's outline; the mask covers the padding box,
// which is the whole 28px control only once those borders are gone.
const GROUPED_STICKY_LEAD_CLS =
  "sticky left-1 right-[var(--zeros-workspace-pinned-lead-right,auto)] transition-none group-data-[workspace-pin-lead]/lane:z-20 group-data-[workspace-pin-lead]/lane:rounded-md group-data-[workspace-pin-lead]/lane:border-0";
// What a pinned lead paints behind itself: its own box plus the carrier between
// it and the pinned pill, which would otherwise stay a four-pixel window onto
// the tabs scrolling past. Painting it HERE rather than on the pill is what
// makes it free — a child of the sticky lead inherits the browser-owned sticky
// offset and needs no scroll-frame JS to stay put.
//
// Square, and at `-z-20` under the rounded hover layer, for one reason: the
// mask hides a surface that is LIGHTER than it, so a rounded mask hands that
// surface back at all four corners as bright wedges. The rounded state layer
// above still shapes hover and focus like every other top-bar control.
const GROUPED_PINNED_LEAD_MASK_CLS =
  "pointer-events-none absolute inset-y-0 left-0 -right-1 -z-20 hidden bg-sidebar-bg group-data-[workspace-pin-lead]/lane:block";
// `flex-auto`, never `flex-1`: flex-1 pins the basis at 0, which would erase
// this button's contents from the tab's intrinsic width and collapse every tab
// onto the 120px floor. `w-auto` undoes the Button base's `w-fit` for the same
// reason. Keep this free of any `font-*` — the weight is inherited.
const WORKSPACE_OPEN_BUTTON_CLS =
  "h-full w-auto min-w-0 flex-auto justify-start gap-2.5 border-0 bg-transparent p-0 text-left text-xs text-inherit shadow-none transition-none hover:bg-transparent hover:text-inherit [&_svg]:size-3.5";
// Hover and selection share the same opaque pill fill, so one gradient serves
// both archive-overlay states without a hard band behind the icon.
// `rounded-r-md` matters only in Grouped mode and is not cosmetic there: this
// overlay's right half is SOLID sidebar-bg-hover out to right-0, and a Grouped
// tab's root is rounded-none, so `overflow-hidden` clips to a square box and the
// overlay squared off the rounded right corners of the pill behind it
// (GROUPED_WORKSPACE_STATE_CLS). Everywhere else the root is rounded-md and
// already clips this to the same shape, so the utility is a no-op — which is why
// it stays unconditional instead of branching on the filter.
const WORKSPACE_ACTION_OVERLAY_CLS =
  "pointer-events-none absolute inset-y-0 right-0 z-20 flex w-10 items-center justify-end rounded-r-md bg-gradient-to-l from-sidebar-bg-hover from-50% to-transparent pr-1 opacity-0 transition-none group-data-[hovered=true]/workspace:opacity-100 focus-within:opacity-100";
const WORKSPACE_ACTION_CLS =
  "pointer-events-auto inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-fg2 transition-[background-color,color] duration-120 ease-out hover:bg-bg2-hover hover:text-fg1";
// A mixed lane hands its leading glyph to the repository icon, so whatever the
// leading slot used to say — agent state, or the design mode marker — moves
// here. Absolutely positioned and therefore ZERO layout: the tab's intrinsic
// width comes from the label, and the paired `-mr-5 pr-5` on the flow child is
// what reserves room without changing the measured box. Shared by the real and
// the optimistic tab so a pending → confirmed swap moves nothing.
const WORKSPACE_TRAILING_STATE_CLS =
  "from-sidebar-bg-hover via-sidebar-bg-hover pointer-events-none absolute inset-y-0 right-1 z-10 flex w-7 items-center justify-end bg-gradient-to-l to-transparent";
// One four-pixel carrier owns every top-bar boundary. Its optional 1×14px
// hairline is centered inside that width, so showing or hiding the separator
// never changes spacing. The leading carrier in the workspace lane also keeps
// the first tab aligned with the selected pill's left-1/right-1 sticky inset.
const TOP_BAR_BOUNDARY_CLS =
  "pointer-events-none flex h-full w-1 shrink-0 items-center justify-center";
const TOP_BAR_SEPARATOR_CLS = "bg-border1 h-[14px] w-px";
const TOP_BAR_ITEM_CLS = "flex h-full shrink-0 items-center";
const TOP_BAR_LEADING_ACTIONS_CLS =
  "flex h-full shrink-0 items-center gap-1 pl-1";
const TOP_BAR_TRAILING_ITEM_CLS = "flex h-full shrink-0 items-center pr-1";
const WORKSPACE_CONTENT_INSET_PX = 4;
const WORKSPACE_STICKY_EDGE_INSET_PX = 4;
// MUST mirror TOP_BAR_BOUNDARY_CLS's w-1. The strip itself is gap-0: one
// carrier sits before each tab, so a sticky tab's natural position is the
// previous tab's right edge plus this width. A separate flex gap would count
// twice and silently offset pin/fade placement.
const WORKSPACE_TAB_GAP_PX = 4;
// Grouped mode is the ONE case where two adjacent carriers mean different
// things: inside a repository the carrier bridges one continuous surface, while
// the carrier before the next repository icon is empty background separating two
// surfaces. Four pixels reads as a seam there, so only that carrier widens to
// eight. Deliberately NOT applied to the lane's leading carrier (it is the
// sticky/content inset) nor to any in-group carrier, both of which the pin math
// assumes equal to WORKSPACE_TAB_GAP_PX.
const WORKSPACE_GROUP_GAP_CLS = "w-2";
// MUST mirror the compact ProjectMarker's `size="icon"` (h-7 w-7).
const WORKSPACE_PINNED_LEAD_WIDTH_PX = 28;
// The horizontal space a pinned repository lead occupies in front of the pinned
// pill: the icon plus the carrier the lead paints itself.
const WORKSPACE_PINNED_LEAD_SLOT_PX =
  WORKSPACE_PINNED_LEAD_WIDTH_PX + WORKSPACE_TAB_GAP_PX;
// Where a Grouped pill pins at the LEADING edge — the lane inset plus the slot
// its repository lead pins into. MUST mirror
// GROUPED_WORKSPACE_STICKY_INSET_CLS's `left-9`. Grouped mode always opens a
// repository with its icon, so the first tab's natural offset is exactly this
// and the reservation costs the unscrolled lane nothing.
const WORKSPACE_GROUPED_LEADING_INSET_PX =
  WORKSPACE_STICKY_EDGE_INSET_PX + WORKSPACE_PINNED_LEAD_SLOT_PX;
// Published on the scroller so the sticky lead's trailing inset tracks the
// pinned pill's content-sized width without a React render per scroll frame.
const WORKSPACE_PINNED_LEAD_RIGHT_VAR = "--zeros-workspace-pinned-lead-right";
// The two pin markers, written on the LANE. `dataset` keys, so the attributes
// are `data-workspace-pin` / `data-workspace-pin-lead` — keep them in step with
// the `group-data-[…]/lane:` variants above.
const WORKSPACE_PIN_ATTR = "workspacePin";
const WORKSPACE_PIN_LEAD_ATTR = "workspacePinLead";
const WORKSPACE_FADE_WIDTH_PX = 24;
// Component-local FLIP motion: short enough to read as displacement rather
// than a transition delay. Reduced-motion users always get the final layout.
const WORKSPACE_REORDER_DURATION_MS = 160;

function TopBarBoundary({
  showSeparator,
  edge = false,
  groupedBackground = false,
  groupGap = false,
  suppressSeparator = false,
}: {
  showSeparator: boolean;
  /** Let the leading line paint above the opaque sticky-edge gutter. */
  edge?: boolean;
  /** Bridges adjacent Grouped items into one repository surface. */
  groupedBackground?: boolean;
  /** Widens the empty carrier that separates two Grouped repositories. */
  groupGap?: boolean;
  /** Group surfaces replace their internal separator hairlines. */
  suppressSeparator?: boolean;
}) {
  return (
    <span
      className={cn(
        TOP_BAR_BOUNDARY_CLS,
        edge && "relative z-40",
        groupedBackground && "h-7 border-y border-border2/50 bg-bg2/50",
        groupGap && WORKSPACE_GROUP_GAP_CLS,
      )}
      data-top-bar-boundary="true"
      aria-hidden="true"
    >
      <span
        className={cn(
          TOP_BAR_SEPARATOR_CLS,
          (!showSeparator || suppressSeparator) && "invisible",
        )}
      />
    </span>
  );
}

function setWorkspaceFadeVisible(
  fade: HTMLDivElement | null,
  visible: boolean,
): void {
  if (!fade) return;
  const opacity = visible ? "1" : "0";
  if (fade.style.opacity !== opacity) fade.style.opacity = opacity;
}

function placeWorkspaceFade(
  fade: HTMLDivElement | null,
  visible: boolean,
  left: number,
): void {
  if (!fade) return;
  const transform = `translate3d(${left}px, 0, 0)`;
  if (fade.style.transform !== transform) fade.style.transform = transform;
  setWorkspaceFadeVisible(fade, visible);
}

/** A sticky element's `offsetLeft` becomes its clamped visual position in
 * Chromium, so the pinned pill and the pinned repository lead can never report
 * their own flow position. Their preceding BOUNDARY CARRIER can: exactly one
 * sits in front of every lane item, it is never sticky, and its right edge is
 * the item's flow position by construction.
 *
 * Reading the carrier rather than the previous flow item also drops two
 * assumptions the neighbour walk had to make — that the carrier between them is
 * the base four pixels (Grouped widens the one before a repository icon to
 * eight) and that the neighbour itself is in flow (the lead now is not). The
 * neighbour walk stays as the fallback for a lane item rendered without one. */
function workspaceTabNaturalOffsetLeft(tab: HTMLElement): number {
  let sibling = tab.previousElementSibling;
  while (sibling) {
    if (sibling instanceof HTMLElement) {
      if (sibling.dataset.topBarBoundary === "true") {
        return sibling.offsetLeft + sibling.offsetWidth;
      }
      if (
        sibling.dataset.topBarFlowItem === "true" &&
        sibling.dataset.topBarPinnedLead !== "true"
      ) {
        return sibling.offsetLeft + sibling.offsetWidth + WORKSPACE_TAB_GAP_PX;
      }
    }
    sibling = sibling.previousElementSibling;
  }
  return WORKSPACE_CONTENT_INSET_PX;
}

/** Toggle one of the lane's pin markers, which CSS keys the pinned presentation
 *  off. Mirrors the `data-hovered` contract: a direct DOM write, never a React
 *  render, so the marker lands on the same frame as the browser-owned sticky
 *  offset it describes. The lane outlives every tab in it, so unlike a per-tab
 *  marker this needs no bookkeeping to follow the selection and no teardown. */
function setLanePinMarker(
  lane: HTMLElement | null,
  attribute: string,
  side: WorkspacePinSide,
): void {
  if (!lane) return;
  if (side === null) {
    if (lane.dataset[attribute] !== undefined) delete lane.dataset[attribute];
    return;
  }
  if (lane.dataset[attribute] !== side) lane.dataset[attribute] = side;
}

/** Keep the repository's right-click menu below the compact title-bar control
 * so it never covers the project name the user acted on. */
function positionMenuBelowTrigger(event: React.MouseEvent<HTMLElement>): void {
  const rect = event.currentTarget.getBoundingClientRect();
  const anchorEvent = event as React.MouseEvent<HTMLElement> & {
    clientX: number;
    clientY: number;
  };
  anchorEvent.clientX = rect.left;
  anchorEvent.clientY = rect.bottom;
}

/** The project registry stopped backfilling arbitrary chat folders long ago,
 * but this one-shot cleanup still removes phantom worktree rows left by older
 * builds. It used to live inside Repository panel and must survive that component's
 * removal. */
function usePruneLegacyPhantomProjects(): void {
  // The guard prevents Strict Mode and Fast Refresh remounts from repeating a
  // storage mutation during one mounted component lifetime.
  const ranRef = useRef(false);
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    if (pruneWorktreePhantomProjects() > 0) notifyProjectsChanged();
  }, []);
}

/** Keep the native-runtime failure explanation mounted now that Repository panel no
 * longer owns it. A missing preload is actionable during development; a real
 * browser session is informational because reload cannot create Electron IPC. */
function useNativeRuntimeNotice(): void {
  const nativeRuntime = useNativeRuntime();
  useEffect(() => {
    if (typeof window === "undefined") return;
    const target = window as Window & {
      __zerosNativeRuntimeToastId__?: string | number;
    };
    const dismissExisting = () => {
      if (target.__zerosNativeRuntimeToastId__ === undefined) return;
      toast.dismiss(target.__zerosNativeRuntimeToastId__);
      target.__zerosNativeRuntimeToastId__ = undefined;
    };
    if (nativeRuntime.status === "ready") {
      dismissExisting();
      return;
    }
    if (window.parent !== window) return;
    if (target.__zerosNativeRuntimeToastId__ !== undefined) return;
    if (nativeRuntime.status === "preload-missing") {
      if (!import.meta.env.DEV) return;
      target.__zerosNativeRuntimeToastId__ = toast.error(
        "Native bridge missing",
        {
          description:
            "The Electron preload didn't inject. This usually means a dev rebuild is in flight or the preload has a build error. Reload the window to retry.",
          duration: Infinity,
          action: {
            label: "Reload",
            onClick: () => window.location.reload(),
          },
        },
      );
      return;
    }
    target.__zerosNativeRuntimeToastId__ = toast.error(
      "Native runtime not detected.",
      {
        description:
          "Run pnpm electron:dev to use git workspaces. (Viewing in a browser tab? Switch to the Electron window.)",
        duration: Infinity,
      },
    );
  }, [nativeRuntime.status]);
}

// --- TYPES ---

interface WorkspaceTabProps {
  /** The real, engine-managed worktree represented by this tab. */
  workspace: Workspace;
  /** Whether the workspace currently owns the app content. */
  active: boolean;
  /** Live coding-chat ids in this worktree, used for agent activity state. */
  chatIds: readonly string[];
  /** Owner icon painted when repositories share one mixed lane. */
  project: Project | null;
  /** Moves agent state to a zero-layout trailing overlay in mixed lanes. */
  mixedRepositories: boolean;
  /** Joins this tab to its repository's continuous Grouped surface. */
  groupedRepository: boolean;
  /** Rounds the trailing edge of the final tab in a Grouped repository. */
  groupEnd: boolean;
  /** Opens the workspace; only code destinations restore or create chat. */
  onSelect: (workspace: Workspace) => void;
  /** Warms the exact chat/tree/file destination on pointer or keyboard intent. */
  onPrefetch: (workspace: Workspace) => void;
  /** Archives the worktree without selecting it first. */
  onArchive: (workspace: Workspace) => void;
  /** Registers the tab so the active workspace can be revealed on navigation. */
  tabRef?: (node: HTMLDivElement | null) => void;
}

const EMPTY_WORKSPACE_CHAT_IDS: readonly string[] = Object.freeze([]);

type TopBarNavItem =
  | {
      kind: "project";
      key: string;
      project: Project;
      compact: boolean;
    }
  | {
      kind: "workspace";
      key: string;
      project: Project;
      workspace: Workspace;
    }
  | {
      kind: "pending";
      key: string;
      project: Project;
      pending: PendingWorkspaceCreate;
    };

// --- CHILD COMPONENTS ---

/** The idle tab glyph for a workspace WITH a PR (2026-07-19): the icon tracks
 *  the PR's live island state — brown PR-arrow while open, red conflict glyph
 *  on merge conflicts, green PR-arrow when ready to merge, a violet merge
 *  glyph when merged, and a red closed glyph when closed. Falls back to the
 *  persisted prState for workspaces whose island hasn't derived yet this
 *  session. Null → the default branch icon. */
function prTabIcon(
  workspace: Workspace,
  islandKind: string | null,
): React.ReactNode | null {
  if (workspace.prNumber == null) return null;
  // Terminal persisted states are authoritative (the engine reconciles them
  // from GitHub via ghPrSync/getPr) — they outrank a possibly-stale live kind
  // from a workspace whose island isn't currently mounted (e.g. merged on
  // github.com while this tab was in the background).
  const kind =
    workspace.prState === "merged" || workspace.prState === "closed"
      ? workspace.prState
      : (islandKind ?? "open");
  switch (kind) {
    case "merged":
      return (
        <GitMerge className="text-violet-fg size-3.5" strokeWidth={1.25} />
      );
    case "closed":
      return (
        <GitPullRequestClosed
          className="text-red-fg size-3.5"
          strokeWidth={1.25}
        />
      );
    case "merge-conflicts":
      return (
        <GitMergeConflict className="text-red-fg size-3.5" strokeWidth={1.25} />
      );
    case "ready-to-merge":
      return (
        <GitPullRequestArrow
          className="text-green-primary size-3.5"
          strokeWidth={1.25}
        />
      );
    default:
      // Every other open-PR state — the brown identity.
      return (
        <GitPullRequestArrow
          className="text-brown-fg size-3.5"
          strokeWidth={1.25}
        />
      );
  }
}

/** In mixed lanes, the repository identity lives inside each workspace tab. Its
 * own right-click target must still expose repository actions without replacing
 * the surrounding workspace context menu. */
function WorkspaceProjectIcon({ project }: { project: Project }) {
  const [iconDialogOpen, setIconDialogOpen] = useState(false);
  const dispatch = useWorkspaceDispatch();
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger
          asChild
          onContextMenu={(event) => {
            event.stopPropagation();
            positionMenuBelowTrigger(event);
          }}
        >
          <span className="inline-flex size-4 shrink-0 items-center justify-center">
            <RepositoryIcon project={project} className="size-4 rounded-sm" />
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem
            onSelect={() => window.setTimeout(() => setIconDialogOpen(true), 0)}
          >
            <ImageIcon />
            <span>Change icon</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() =>
              dispatch({
                type: "OPEN_REPO_PAGE",
                projectId: project.id,
                view: DEFAULT_REPO_SETTINGS_VIEW,
              })
            }
          >
            <Settings />
            <span>Repository Settings</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <RepositoryIconDialog
        project={project}
        open={iconDialogOpen}
        onOpenChange={setIconDialogOpen}
      />
    </>
  );
}

function WorkspaceTab({
  workspace,
  active,
  chatIds,
  project,
  mixedRepositories,
  groupedRepository,
  groupEnd,
  onSelect,
  onPrefetch,
  onArchive,
  tabRef,
}: WorkspaceTabProps) {
  const requestedMode = usePendingWorkspaceMode(workspace.id);
  const modeSwitching = requestedMode !== null;
  const designWorkspace = workspace.kind === "design";
  const agentChatIds = designWorkspace ? EMPTY_WORKSPACE_CHAT_IDS : chatIds;
  const working = useAnyChatAgentWorking(agentChatIds);
  const awaitingKind = useAnyChatAwaitingKind(agentChatIds);
  const islandKind = usePrIslandKind(workspace.id, workspace.prNumber);
  const runActionRunning = useAnyRunActionRunning(workspace.path);
  const changeLines = useWorkspaceChangeLines(workspace);
  const label = workspaceLabel(workspace);
  const archiving = useWorkspaceArchiving(workspace.id);
  const trailingAgentState =
    mixedRepositories &&
    !archiving &&
    !designWorkspace &&
    (awaitingKind !== null || working);
  // A mixed lane spends the leading glyph on repository identity, so the mode
  // marker has to move rather than disappear: design is a different KIND of
  // workspace, and its branch name (the same colour-word allocation code
  // workspaces get) says nothing about that. Design rows never hold agent
  // chats, so the two trailing states are mutually exclusive by construction.
  // The condition mirrors the leading-glyph swap below EXACTLY — including
  // `project` — so a row the lane could not attribute to a repository keeps its
  // PenTool in the leading slot rather than painting one in both.
  const trailingDesignMark =
    mixedRepositories && !!project && !archiving && designWorkspace;
  const trailingTabState = trailingAgentState || trailingDesignMark;

  const tab = (
    <div
      ref={tabRef}
      className={cn(
        WORKSPACE_TAB_CLS,
        groupedRepository && GROUPED_REPOSITORY_ITEM_CLS,
        groupedRepository && groupEnd && "rounded-r-md border-r",
        groupedRepository && GROUPED_WORKSPACE_STICKY_INSET_CLS,
        groupedRepository && GROUPED_PINNED_WORKSPACE_CLS,
        WORKSPACE_PINNED_EDGE_CLS,
      )}
      data-active={active}
      data-workspace-tab="true"
      data-top-bar-flow-item="true"
      data-streaming={(!designWorkspace && working) || undefined}
      aria-busy={archiving || modeSwitching || undefined}
    >
      {groupedRepository && active && (
        <span
          className={GROUPED_PINNED_WORKSPACE_MASK_CLS}
          aria-hidden="true"
        />
      )}
      {groupedRepository && (
        <span className={GROUPED_WORKSPACE_STATE_CLS} aria-hidden="true" />
      )}
      <Button
        type="button"
        variant="ghost"
        size="default"
        className={cn(
          WORKSPACE_OPEN_BUTTON_CLS,
          // Make room by borrowing from the elastic label, then cancel that
          // padding's outer contribution. The tab's measured width therefore
          // stays identical when the trailing state appears or disappears.
          trailingTabState && "-mr-5 pr-5",
        )}
        aria-current={active ? "page" : undefined}
        aria-label={workspaceTabDescription({
          label,
          runActionRunning,
          changeLines,
        })}
        disabled={archiving}
        onPointerEnter={() => onPrefetch(workspace)}
        onFocus={() => onPrefetch(workspace)}
        onClick={() => onSelect(workspace)}
      >
        {mixedRepositories && project && !archiving ? (
          <WorkspaceProjectIcon project={project} />
        ) : (
          <span
            className="inline-flex size-4 shrink-0 items-center justify-center"
            aria-hidden="true"
          >
            {archiving ? (
              <ZerosSpinner size={16} label="Archiving workspace" />
            ) : designWorkspace ? (
              <PenTool className="size-3.5" strokeWidth={1.25} />
            ) : awaitingKind === "plan" ? (
              <ClipboardList className="size-3.5" strokeWidth={1.25} />
            ) : awaitingKind === "input" ? (
              <MessageCircleQuestionMark
                className="size-3.5"
                strokeWidth={1.25}
              />
            ) : working ? (
              <ZerosSpinner size={16} variant="agent" label="Agent working" />
            ) : (
              (prTabIcon(workspace, islandKind) ?? (
                <GitBranch className="size-3.5" strokeWidth={1.25} />
              ))
            )}
          </span>
        )}
        {/* The ONLY elastic child. Everything after it is shrink-0, so the tab's
            180px cap is spent truncating the branch name and never the numbers
            or the wave. `flex-auto` (basis auto) is what lets the name's real
            width reach the tab's intrinsic size — see WORKSPACE_OPEN_BUTTON_CLS. */}
        <span className="min-w-0 flex-auto truncate text-left">{label}</span>
        {/* Both indicators, counts then wave, so a running workspace still
            reports what it changed. Each is independently optional and the tab
            is content-sized, so it only pays for the ones actually present.
            Archiving hides the counts — that tab is already a spinner row —
            but a run genuinely still running keeps saying so. */}
        {!archiving && (
          <WorkspaceChangeCounts {...changeLines} active={active} />
        )}
        {runActionRunning && (
          <RunWave size={12} className="text-blue-primary" />
        )}
      </Button>
      {trailingTabState && (
        <span className={WORKSPACE_TRAILING_STATE_CLS} aria-hidden="true">
          {trailingDesignMark ? (
            <PenTool className="size-3.5" strokeWidth={1.25} />
          ) : awaitingKind === "plan" ? (
            <ClipboardList className="size-3.5" strokeWidth={1.25} />
          ) : awaitingKind === "input" ? (
            <MessageCircleQuestionMark
              className="size-3.5"
              strokeWidth={1.25}
            />
          ) : (
            <ZerosSpinner size={16} variant="agent" label="Agent working" />
          )}
        </span>
      )}
      {!archiving && !modeSwitching && (
        <div className={WORKSPACE_ACTION_OVERLAY_CLS}>
          <Tooltip label="Archive workspace" side="bottom">
            <button
              type="button"
              className={WORKSPACE_ACTION_CLS}
              aria-label={`Archive workspace ${label}`}
              onClick={(event) => {
                event.stopPropagation();
                onArchive(workspace);
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Archive className="size-3.5" strokeWidth={1.25} />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );

  return (
    <WorkspaceContextMenu
      workspace={workspace}
      onArchive={() => onArchive(workspace)}
      archiveDisabled={archiving || modeSwitching}
      placement="below-trigger"
    >
      {tab}
    </WorkspaceContextMenu>
  );
}

/** Placeholder tab for a workspace whose create RPC is still in flight. The
 *  branch name is reserved at prepare time, so the tab shows the REAL git
 *  icon + workspace name from the first frame — identical to the real
 *  WorkspaceTab that replaces it (no spinner, no shimmer, no reflow).
 *  Typography included: the label inherits its weight from WORKSPACE_TAB_CLS,
 *  the same container class the real tab uses, so the name does not thicken
 *  when the placeholder is swapped out. Keep this span free of any `font-*`
 *  utility — that is what keeps the two in lockstep.
 *  WIDTH is the other half of that promise now that tabs are content-sized.
 *  This span must stay `flex-auto` (a `flex-1` basis of 0 would collapse the
 *  placeholder onto the 120px floor while the real tab sizes to its name), and
 *  the `ml-2.5` here is exactly the `gap-2.5` the real tab's Button applies
 *  between icon and label — so both measure icon + 10px + name and the swap
 *  moves nothing. A brand-new workspace has no diff and no run, so it has no
 *  trailing indicators to account for either.
 *  Non-interactive — there is nothing to open yet. */
function PendingWorkspaceTab({
  label,
  kind = "code",
  project,
  mixedRepositories = false,
  groupedRepository = false,
  groupEnd = false,
  active = false,
  tabRef,
}: {
  label: string;
  kind?: "code" | "design";
  project?: Project | null;
  mixedRepositories?: boolean;
  groupedRepository?: boolean;
  groupEnd?: boolean;
  active?: boolean;
  /** Registers the optimistic tab with the same sticky/reveal machinery. */
  tabRef?: (node: HTMLDivElement | null) => void;
}) {
  // Same relocation the confirmed tab makes: a mixed lane's leading glyph is
  // the repository icon, so the design marker moves to the zero-layout trailing
  // slot. Both tabs render it identically, so the pending → confirmed swap
  // neither drops nor re-adds the marker.
  const trailingDesignMark =
    mixedRepositories && !!project && kind === "design";
  return (
    <div
      ref={tabRef}
      className={cn(
        WORKSPACE_TAB_CLS,
        groupedRepository && GROUPED_REPOSITORY_ITEM_CLS,
        groupedRepository && groupEnd && "rounded-r-md border-r",
        groupedRepository && GROUPED_WORKSPACE_STICKY_INSET_CLS,
        groupedRepository && GROUPED_PINNED_WORKSPACE_CLS,
        WORKSPACE_PINNED_EDGE_CLS,
      )}
      data-workspace-tab="true"
      data-top-bar-flow-item="true"
      data-active={active}
      role="status"
      aria-live="polite"
    >
      {groupedRepository && active && (
        <span
          className={GROUPED_PINNED_WORKSPACE_MASK_CLS}
          aria-hidden="true"
        />
      )}
      {groupedRepository && (
        <span className={GROUPED_WORKSPACE_STATE_CLS} aria-hidden="true" />
      )}
      {mixedRepositories && project ? (
        <WorkspaceProjectIcon project={project} />
      ) : (
        <span
          className="inline-flex size-4 shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          {kind === "design" ? (
            <PenTool className="size-3.5" strokeWidth={1.25} />
          ) : (
            <GitBranch className="size-3.5" strokeWidth={1.25} />
          )}
        </span>
      )}
      <span
        className={cn(
          "ml-2.5 min-w-0 flex-auto truncate text-left",
          // Mirrors the confirmed tab's width-neutral reservation.
          trailingDesignMark && "-mr-5 pr-5",
        )}
      >
        {label}
      </span>
      {trailingDesignMark && (
        <span className={WORKSPACE_TRAILING_STATE_CLS} aria-hidden="true">
          <PenTool className="size-3.5" strokeWidth={1.25} />
        </span>
      )}
    </div>
  );
}

interface ProjectMarkerProps {
  project: Project;
  openingRoot: string | null;
  compact: boolean;
  /** Starts the continuous repository surface in the Grouped lane. */
  grouped?: boolean;
  /** This repository owns the selected workspace, so its icon pins to whichever
   *  overflow edge that workspace's pill reaches and stays beside it. The
   *  measure pass finds it by `data-top-bar-pinned-lead`; no ref needed. */
  pinnedLead?: boolean;
  /** Grouped repository icons are useful shortcuts into that repository view. */
  onSelect?: (project: Project) => void;
}

function ProjectIconChip({
  project,
  opening,
}: {
  project: Project;
  opening: boolean;
}) {
  return (
    <span className={PROJECT_CHIP_CLS} aria-hidden="true">
      {opening ? (
        <ZerosSpinner size={14} label={`Opening ${project.name}`} />
      ) : (
        <RepositoryIcon project={project} className="size-full rounded-sm" />
      )}
    </span>
  );
}

function ProjectMarker({
  project,
  openingRoot,
  compact,
  grouped = false,
  pinnedLead = false,
  onSelect,
}: ProjectMarkerProps) {
  const selectedOpening = openingRoot === project.repoRoot;
  const [iconDialogOpen, setIconDialogOpen] = useState(false);
  const dispatch = useWorkspaceDispatch();

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild onContextMenu={positionMenuBelowTrigger}>
          <Button
            type="button"
            variant="ghost"
            size={compact ? "icon" : "default"}
            className={
              compact
                ? cn(
                    ICON_BUTTON_CLS,
                    grouped && GROUPED_PROJECT_MARKER_CLS,
                    // AFTER the grouped surface: `sticky` and `relative` share
                    // tailwind-merge's position group, so the lead only wins
                    // that key by being declared last.
                    pinnedLead && GROUPED_STICKY_LEAD_CLS,
                  )
                : PROJECT_TRIGGER_CLS
            }
            aria-label={
              compact ? `Show ${project.name} workspaces` : project.name
            }
            data-top-bar-flow-item="true"
            data-top-bar-pinned-lead={pinnedLead || undefined}
            onClick={onSelect ? () => onSelect(project) : undefined}
          >
            {pinnedLead && (
              <span
                className={GROUPED_PINNED_LEAD_MASK_CLS}
                aria-hidden="true"
              />
            )}
            {grouped && (
              <span className={GROUPED_PROJECT_STATE_CLS} aria-hidden="true" />
            )}
            <ProjectIconChip project={project} opening={selectedOpening} />
            {!compact && (
              <span className="min-w-0 flex-1 truncate text-left">
                {project.name}
              </span>
            )}
          </Button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem
            onSelect={() => window.setTimeout(() => setIconDialogOpen(true), 0)}
          >
            <ImageIcon />
            <span>Change icon</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              dispatch({
                type: "OPEN_REPO_PAGE",
                projectId: project.id,
                view: DEFAULT_REPO_SETTINGS_VIEW,
              });
            }}
          >
            <Settings />
            <span>Repository Settings</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <RepositoryIconDialog
        project={project}
        open={iconDialogOpen}
        onOpenChange={setIconDialogOpen}
      />
    </>
  );
}

function archivedAge(workspace: Workspace): string {
  const age = formatCompactAge(workspace.archivedAt ?? 0);
  return age === "now"
    ? "Archived now"
    : age
      ? `Archived ${age} ago`
      : "Archived";
}

function ArchivedWorkspacePicker({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const openWorkspace = useOpenWorkspace();
  const activeOrganization = useActiveOrganization();
  const { workspaces, loading, error, refresh } = useArchivedWorkspaces(
    project.repoSlug,
  );
  const accessibleWorkspaces = useMemo(
    () => filterRowsForOrganization(workspaces, activeOrganization),
    [activeOrganization, workspaces],
  );

  const allForProject = useMemo(
    () => filterArchivedWorkspaces(accessibleWorkspaces, project.repoSlug, ""),
    [accessibleWorkspaces, project.repoSlug],
  );
  const matches = useMemo(
    () =>
      filterArchivedWorkspaces(accessibleWorkspaces, project.repoSlug, query),
    [accessibleWorkspaces, project.repoSlug, query],
  );

  useEffect(() => {
    setQuery("");
  }, [project.id]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <Tooltip label="Archived workspaces" side="bottom">
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={MENU_ICON_BUTTON_CLS}
            data-active={open}
            aria-label={`Archived workspaces for ${project.name}`}
            aria-expanded={open}
          >
            <Archive className="size-3.5" strokeWidth={1.5} />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        align="end"
        sideOffset={5}
        className="w-[320px] overflow-hidden p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            aria-label="Search archived workspaces"
            placeholder="Search archived workspaces…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-[320px]">
            <div className="text-fg2 flex items-center gap-2 px-3 pt-2 pb-1 text-xs">
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {!loading && !error && (
                <span className="shrink-0 tabular-nums">
                  {allForProject.length}
                </span>
              )}
            </div>

            {loading && allForProject.length === 0 ? (
              <div className="min-h-12" aria-busy="true" />
            ) : error ? (
              <div className="px-3 py-4">
                <p className="text-fg2 text-xs">
                  Couldn’t load archived workspaces.
                </p>
                <button
                  type="button"
                  className="text-fg1 mt-2 text-xs hover:underline"
                  onClick={refresh}
                >
                  Try again
                </button>
              </div>
            ) : allForProject.length === 0 ? (
              <div className="text-fg2 px-3 py-5 text-xs">
                No archived workspaces in this repository.
              </div>
            ) : matches.length === 0 ? (
              <div className="text-fg2 px-3 py-5 text-xs">
                No archived workspaces match “{query.trim()}”.
              </div>
            ) : (
              <div
                className="p-1"
                role="list"
                aria-label={`${project.name} archived workspaces`}
              >
                {matches.map((workspace) => (
                  <button
                    type="button"
                    key={workspace.id}
                    className="hover:bg-bg2 flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-2 text-left disabled:pointer-events-none disabled:opacity-60"
                    role="listitem"
                    disabled={restoringId !== null}
                    onClick={() => {
                      if (restoringId) return;
                      setRestoringId(workspace.id);
                      void restoreWorkspaceWithFeedback(workspace, {
                        label: workspaceLabel(workspace),
                        onSettled: () => setRestoringId(null),
                        onRestored: (result) => {
                          setOpen(false);
                          openWorkspace(result.workspace);
                        },
                      });
                    }}
                  >
                    {restoringId === workspace.id ? (
                      <ZerosSpinner size={14} />
                    ) : workspace.kind === "design" ? (
                      <PenTool
                        className="text-fg2 size-3.5 shrink-0"
                        strokeWidth={1.25}
                        aria-hidden="true"
                      />
                    ) : (
                      <GitBranch
                        className="text-fg2 size-3.5 shrink-0"
                        strokeWidth={1.25}
                        aria-hidden="true"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-fg1 truncate text-xs">
                        {workspaceLabel(workspace)}
                      </div>
                      <div className="text-fg2 truncate text-xs">
                        {archivedAge(workspace)}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// --- ROOT COMPONENT ---

export function TopBar() {
  const chats = useChats();
  const workspaceActivityByFolder = useWorkspaceActivityByFolder();
  const activePage = useActivePage();
  const activeRepoId = useActiveRepoId();
  const createWorkspaceProjectId = useCreateWorkspaceProjectId();
  const activeOrganization = useActiveOrganization();
  const activeFolder = useWorkspaceStore(selectActiveFolder);
  // True while the active folder is a freshly-announced worktree whose create
  // is still landing — the list-validation effect below must not bounce it.
  const activeFolderProvisioning = useWorkspaceProvisioning(activeFolder);
  const dispatch = useWorkspaceDispatch();
  const sessions = useAgentSessions();
  const { projects } = useProjects();
  const projectRepoRoots = useMemo(
    () => projects.map((project) => project.repoRoot),
    [projects],
  );
  const { openDispatcher, pendingProject, openingRoot } = useAddProject();
  const openWorkspace = useOpenWorkspace();
  const archiveWorkspace = useArchiveWorkspace();

  usePruneLegacyPhantomProjects();
  useSyncProjectsToEngine();
  usePrefetchSettings(projectRepoRoots);
  useNativeRuntimeNotice();

  const activeProject = useMemo(
    () => findProjectForFolder(activeFolder, projects),
    [activeFolder, projects],
  );

  // The whole row is a native window drag target except for its interactive
  // descendants, which useCustomWindowDrag excludes automatically.
  const topBarRef = useRef<HTMLElement | null>(null);
  useCustomWindowDrag(topBarRef);

  const requestedFilter = useWorkspaceListFilter();
  const workspaceListFilter = useMemo(
    () => effectiveWorkspaceListFilter(requestedFilter, projects),
    [projects, requestedFilter],
  );
  useEffect(() => {
    if (workspaceListFilter !== requestedFilter) {
      dispatch({
        type: "SET_WORKSPACE_LIST_FILTER",
        filter: workspaceListFilter,
      });
    }
  }, [dispatch, requestedFilter, workspaceListFilter]);
  const filterProjectId = workspaceListFilterProjectId(workspaceListFilter);
  const filterProject = useMemo(
    () =>
      filterProjectId
        ? (projects.find((project) => project.id === filterProjectId) ?? null)
        : null,
    [filterProjectId, projects],
  );
  const routedRepoProject = useMemo(
    () =>
      activePage === "repo"
        ? (projects.find((project) => project.id === activeRepoId) ?? null)
        : null,
    [activePage, activeRepoId, projects],
  );
  const routedCreateProject = useMemo(
    () =>
      activePage === "create" && createWorkspaceProjectId
        ? (projects.find(
            (project) => project.id === createWorkspaceProjectId,
          ) ?? null)
        : null,
    [activePage, createWorkspaceProjectId, projects],
  );
  const contextProject =
    filterProject ??
    routedRepoProject ??
    routedCreateProject ??
    activeProject ??
    projects[0] ??
    null;

  // The cross-repository strip projects one shared exact-key union. Keep a
  // separate subscription to the active owner for route validation: only that
  // settled key may reject a remembered destination.
  const { workspaces: liveWorkspaces, loading: liveLoading } =
    useLiveWorkspaces();
  const {
    workspaces: activeProjectWorkspaces,
    loading: activeProjectLoading,
    refreshing: activeProjectRefreshing,
  } = useWorkspacesFor(activeProject?.repoSlug ?? null);

  // "Work in local main" (Settings → Experimental, off by default). This gates
  // the main TAB and where a repo switch lands — never the synthetic row
  // itself: `mainWorkspace` still backs active-tab resolution for repo-root
  // chats, the bounce-to-main safety net, and the delete/remove escape hatches.
  // Dropping it from `visibleWorkspaces` would strand those paths instead.
  const [workInLocalMain] = useExperimentalFeature("workInLocalMain");

  const accessibleWorkspaces = useMemo(
    () => filterRowsForOrganization(liveWorkspaces, activeOrganization),
    [activeOrganization, liveWorkspaces],
  );
  const activeProjectAccessibleWorkspaces = useMemo(
    () =>
      filterRowsForOrganization(activeProjectWorkspaces, activeOrganization),
    [activeOrganization, activeProjectWorkspaces],
  );

  const activeProjectDestinations = useMemo(
    () =>
      activeProject
        ? withLocalMainWorkspace(
            activeProject,
            activeProjectAccessibleWorkspaces,
          )
        : [],
    [activeProject, activeProjectAccessibleWorkspaces],
  );
  const mainWorkspace = activeProjectDestinations[0] ?? null;
  const realWorkspaces = useMemo(
    () => selectLiveVisible(accessibleWorkspaces),
    [accessibleWorkspaces],
  );
  useWorkspaceRunActivitySync(realWorkspaces);

  // File indexes are the most visible cold-workspace waterfall. Warm a bounded
  // window only after the repository list settles and the browser is idle;
  // pointer/focus intent still handles the exact file/diff/chat destination.
  useEffect(() => {
    if (liveLoading || realWorkspaces.length === 0) return;
    const targets = realWorkspaces.slice(0, 8);
    const warm = () => {
      for (const workspace of targets) warmWorkspaceFiles(workspace.path);
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm, { timeout: 1_000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 0);
    return () => window.clearTimeout(id);
  }, [liveLoading, realWorkspaces]);
  // In-flight creates across all repos — used both to render pending tabs and to
  // protect a slow-create's announced path from the bounce-to-main effect.
  const rawPendingCreates = usePendingCreatesAll();
  const allPendingCreates = useMemo(
    () => filterRowsForOrganization(rawPendingCreates, activeOrganization),
    [activeOrganization, rawPendingCreates],
  );
  const dedupedPendingCreates = useMemo(
    () => dedupePendingCreates(allPendingCreates, realWorkspaces),
    [allPendingCreates, realWorkspaces],
  );

  const chatIdsByWorkspace = useMemo(() => {
    const liveChats = chats.filter((chat) => !chat.archived);
    const ids = new Map<string, string[]>();
    for (const workspace of realWorkspaces) ids.set(workspace.id, []);
    for (const chat of liveChats) {
      const workspace = findWorkspaceForFolder(chat.folder, realWorkspaces);
      if (!workspace) continue;
      ids.get(workspace.id)?.push(chat.id);
    }
    return ids;
  }, [chats, realWorkspaces]);
  const workspaceActivity = useMemo<WorkspaceTabActivity>(() => {
    const activeAtByWorkspaceId = new Map<string, number>();
    for (const [folder, activeAt] of Object.entries(
      workspaceActivityByFolder,
    )) {
      const workspace = findWorkspaceForFolder(folder, realWorkspaces);
      if (!workspace) continue;
      activeAtByWorkspaceId.set(
        workspace.id,
        Math.max(activeAtByWorkspaceId.get(workspace.id) ?? 0, activeAt),
      );
    }
    return { activeAtByWorkspaceId };
  }, [realWorkspaces, workspaceActivityByFolder]);

  const workspaceGroups = useMemo(
    () =>
      workspaceTabGroups(
        workspaceListFilter,
        projects,
        realWorkspaces,
        workspaceActivity,
      ),
    [projects, realWorkspaces, workspaceActivity, workspaceListFilter],
  );
  const navItems = useMemo<TopBarNavItem[]>(() => {
    const pendingByProject = new Map<string, PendingWorkspaceCreate[]>();
    for (const pending of dedupedPendingCreates) {
      const project =
        projects.find((candidate) => candidate.repoRoot === pending.repoRoot) ??
        findProjectForFolder(pending.repoRoot, projects);
      if (!project) continue;
      const rows = pendingByProject.get(project.id);
      if (rows) rows.push(pending);
      else pendingByProject.set(project.id, [pending]);
    }
    for (const rows of pendingByProject.values()) {
      rows.sort((a, b) => b.startedAt - a.startedAt);
    }

    if (isMixedWorkspaceListFilter(workspaceListFilter)) {
      const pending = [...pendingByProject.entries()]
        .flatMap(([projectId, rows]) =>
          rows.map((row) => ({
            row,
            project: projects.find((candidate) => candidate.id === projectId),
          })),
        )
        .filter(
          (entry): entry is { row: PendingWorkspaceCreate; project: Project } =>
            !!entry.project,
        )
        .sort((a, b) => b.row.startedAt - a.row.startedAt);
      const pendingItems: TopBarNavItem[] = pending.map(({ row, project }) => ({
        kind: "pending",
        key: `pending:${row.token}`,
        pending: row,
        project,
      }));
      const workspaceItems: TopBarNavItem[] = [];
      for (const workspace of workspaceGroups[0]?.workspaces ?? []) {
        const project = findProjectForFolder(workspace.repoRoot, projects);
        if (project) {
          workspaceItems.push({
            kind: "workspace",
            key: `workspace:${workspace.id}`,
            workspace,
            project,
          });
        }
      }
      const items = [...pendingItems, ...workspaceItems];
      if (workspaceListFilter !== "active") return items;
      return items.sort((left, right) => {
        const activeAt = (item: TopBarNavItem): number => {
          if (item.kind === "workspace") {
            return workspaceActivityTimestamp(
              item.workspace,
              workspaceActivity,
            );
          }
          if (item.kind === "pending") {
            return Math.max(
              item.pending.startedAt,
              item.pending.path
                ? (workspaceActivityByFolder[item.pending.path] ?? 0)
                : 0,
            );
          }
          return Number.NEGATIVE_INFINITY;
        };
        // Stable sorting preserves the painted source order for equal clocks.
        return activeAt(right) - activeAt(left);
      });
    }

    const groupByProjectId = new Map(
      workspaceGroups.flatMap((group) =>
        group.project ? [[group.project.id, group] as const] : [],
      ),
    );
    const visibleProjects = filterProject
      ? [filterProject]
      : projects.filter(
          (project) =>
            (groupByProjectId.get(project.id)?.workspaces.length ?? 0) > 0 ||
            (pendingByProject.get(project.id)?.length ?? 0) > 0,
        );
    return visibleProjects.flatMap((project): TopBarNavItem[] => [
      ...(workspaceListFilter === "grouped"
        ? [
            {
              kind: "project" as const,
              key: `project:${project.id}`,
              project,
              compact: true,
            },
          ]
        : []),
      ...(pendingByProject.get(project.id) ?? []).map((pending) => ({
        kind: "pending" as const,
        key: `pending:${pending.token}`,
        project,
        pending,
      })),
      ...(groupByProjectId.get(project.id)?.workspaces ?? []).map(
        (workspace) => ({
          kind: "workspace" as const,
          key: `workspace:${workspace.id}`,
          project,
          workspace,
        }),
      ),
    ]);
  }, [
    dedupedPendingCreates,
    filterProject,
    projects,
    workspaceGroups,
    workspaceActivity,
    workspaceActivityByFolder,
    workspaceListFilter,
  ]);

  // A cold repository switch is allowed to publish its remembered folder
  // before the workspace list settles. Only a completed exact-key snapshot may
  // invalidate that identity; when it proves the worktree was deleted, move to
  // main as a new authoritative navigation (never as an initial-cache guess).
  useEffect(() => {
    if (
      activePage !== "workspace" ||
      !activeFolder ||
      !activeProject ||
      activeFolder === activeProject.repoRoot ||
      activeProjectLoading ||
      activeProjectRefreshing ||
      peekWorkspacesFor(activeProject.repoSlug) === undefined
    ) {
      return;
    }
    if (
      (mainWorkspace &&
        findWorkspaceForFolder(activeFolder, [mainWorkspace])) ||
      findWorkspaceForFolder(activeFolder, activeProjectAccessibleWorkspaces)
    ) {
      if (
        useWorkspaceStore.getState().pendingWorkspaceValidationFolder ===
        activeFolder
      ) {
        dispatch({ type: "CONFIRM_WORKSPACE_TARGET", folder: activeFolder });
      }
      return;
    }
    // Optimistic create in flight: the active folder is an announced worktree
    // whose row hasn't landed in the list yet — bouncing to main here would
    // yank the user off the "Setting up workspace" surface they just opened.
    // The exact create intent clears on authoritative publication/rollback, so
    // this guard cannot be held by Workbench's separate presentation settling.
    if (activeFolderProvisioning) return;
    // A slow create (past the ~60s settling cap) whose real row hasn't landed
    // yet must not be bounced to main — its placeholder create is still in
    // flight, so the announced path is legitimate even though it isn't listed.
    if (allPendingCreates.some((c) => c.path === activeFolder)) return;
    openWorkspace(
      resolveRepoWorkspaceDestination({
        project: activeProject,
        rememberedFolder: activeFolder,
        cachedWorkspaces: activeProjectAccessibleWorkspaces,
        allowLocalMain: workInLocalMain,
      }),
    );
  }, [
    activeFolder,
    activeFolderProvisioning,
    activePage,
    activeProject,
    activeProjectAccessibleWorkspaces,
    allPendingCreates,
    dispatch,
    activeProjectLoading,
    activeProjectRefreshing,
    mainWorkspace,
    openWorkspace,
    workInLocalMain,
  ]);

  const activeWorkspaceId = useMemo(() => {
    if (activePage !== "workspace" || !activeFolder) return null;
    const visible = navItems.flatMap((item) =>
      item.kind === "workspace" ? [item.workspace] : [],
    );
    const engineWorkspace = findWorkspaceForFolder(activeFolder, visible);
    if (engineWorkspace) return engineWorkspace.id;
    // Reuse the normalized folder resolver for `/private/var` ↔ `/var` and
    // chats rooted in a subdirectory of main. A raw prefix check would leave
    // the main icon inactive for those otherwise-valid paths.
    const insideMainCheckout = mainWorkspace
      ? !!findWorkspaceForFolder(activeFolder, [mainWorkspace])
      : false;
    return insideMainCheckout ? mainWorkspace.id : null;
  }, [activeFolder, activePage, mainWorkspace, navItems]);
  const activePendingCreate = useMemo(() => {
    if (activePage !== "workspace") return null;
    return (
      dedupedPendingCreates.find(
        (pending) => !!pending.path && pending.path === activeFolder,
      ) ?? null
    );
  }, [activeFolder, activePage, dedupedPendingCreates]);
  // A create publishes its destination before the engine-managed Workspace row
  // exists. Use the optimistic token until that row replaces it so the selected
  // tab is revealable and sticky for the entire transition.
  const activeWorkspaceTabKey =
    activeWorkspaceId ?? activePendingCreate?.token ?? null;

  const groupedLane = workspaceListFilter === "grouped";
  /** The repository whose icon travels with the selected pill. Only Grouped
   *  paints repository icons in the lane at all; the mixed lanes carry the
   *  identity inside each tab, and a repository-only lane has nothing to
   *  disambiguate. Null keeps every icon in ordinary flow. */
  const pinnedLeadProjectId = useMemo(() => {
    if (!groupedLane || !activeWorkspaceTabKey) return null;
    const owner = navItems.find((item) =>
      item.kind === "workspace"
        ? item.workspace.id === activeWorkspaceTabKey
        : item.kind === "pending"
          ? item.pending.token === activeWorkspaceTabKey
          : false,
    );
    return owner?.project.id ?? null;
  }, [activeWorkspaceTabKey, groupedLane, navItems]);

  const workspaceNavRef = useRef<HTMLElement | null>(null);
  const workspaceTabRefs = useRef(new Map<string, HTMLDivElement>());
  const workspaceReorderSnapshotRef = useRef<{
    filter: WorkspaceListFilter;
    positions: Map<string, number>;
  } | null>(null);
  const workspaceReorderAnimationsRef = useRef(new Map<string, Animation>());
  const workspaceOuterLeftFadeRef = useRef<HTMLDivElement | null>(null);
  const workspaceOuterRightFadeRef = useRef<HTMLDivElement | null>(null);
  const workspaceAfterPinnedLeftFadeRef = useRef<HTMLDivElement | null>(null);
  const workspaceBeforePinnedRightFadeRef = useRef<HTMLDivElement | null>(null);
  const workspacePointerRef = useRef<{
    clientX: number;
    clientY: number;
  } | null>(null);
  const workspaceHoveredTabRef = useRef<HTMLDivElement | null>(null);

  const setWorkspaceHoveredTab = useCallback(
    (nextTab: HTMLDivElement | null) => {
      const currentTab = workspaceHoveredTabRef.current;
      if (currentTab === nextTab) return;
      currentTab?.removeAttribute("data-hovered");
      if (nextTab) nextTab.dataset.hovered = "true";
      workspaceHoveredTabRef.current = nextTab;
    },
    [],
  );

  /** Native :hover can remain on the element that used to be under a
   * stationary pointer during compositor scrolling. Re-hit-test the stored
   * viewport coordinate on every scroll frame and update a single explicit
   * hover target without involving React state or a render. */
  const retargetWorkspaceHover = useCallback(() => {
    const nav = workspaceNavRef.current;
    const pointer = workspacePointerRef.current;
    if (!nav || !pointer) {
      setWorkspaceHoveredTab(null);
      return;
    }

    const navRect = nav.getBoundingClientRect();
    const insideHoverArea =
      pointer.clientX >= navRect.left + WORKSPACE_STICKY_EDGE_INSET_PX &&
      pointer.clientX < navRect.right - WORKSPACE_STICKY_EDGE_INSET_PX &&
      pointer.clientY >= navRect.top &&
      pointer.clientY < navRect.bottom;
    if (!insideHoverArea) {
      setWorkspaceHoveredTab(null);
      return;
    }

    const hit = document.elementFromPoint(pointer.clientX, pointer.clientY);
    const candidate = hit?.closest('[data-workspace-tab="true"]') ?? null;
    setWorkspaceHoveredTab(
      candidate instanceof HTMLDivElement && nav.contains(candidate)
        ? candidate
        : null,
    );
  }, [setWorkspaceHoveredTab]);

  const handleWorkspacePointer = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") {
        workspacePointerRef.current = null;
        setWorkspaceHoveredTab(null);
        return;
      }
      workspacePointerRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
      };
      retargetWorkspaceHover();
    },
    [retargetWorkspaceHover, setWorkspaceHoveredTab],
  );

  const handleWorkspaceWheel = useCallback(
    (event: React.WheelEvent<HTMLElement>) => {
      // Wheel/trackpad events carry viewport coordinates and can be the first
      // input observed when the pointer was already resting over the strip.
      workspacePointerRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
      };
      retargetWorkspaceHover();
    },
    [retargetWorkspaceHover],
  );

  const clearWorkspacePointer = useCallback(() => {
    workspacePointerRef.current = null;
    setWorkspaceHoveredTab(null);
  }, [setWorkspaceHoveredTab]);

  const registerWorkspaceTab = useCallback(
    (workspaceId: string, node: HTMLDivElement | null) => {
      if (node) workspaceTabRefs.current.set(workspaceId, node);
      else workspaceTabRefs.current.delete(workspaceId);
    },
    [],
  );

  const measureWorkspaceStrip = useCallback(() => {
    const nav = workspaceNavRef.current;
    if (!nav) return;

    const overflow = horizontalOverflow({
      scrollLeft: nav.scrollLeft,
      scrollWidth: nav.scrollWidth,
      clientWidth: nav.clientWidth,
    });

    // Resolved from the DOM rather than from workspaceTabRefs. The pin
    // decision, the markers and the fade offsets all have to describe the pill
    // that is ON SCREEN, and a workspace-id-keyed ref map cannot promise that:
    // it is torn down and repopulated through a fresh callback on every render
    // and can hand back a node React has already replaced — which still
    // measures a plausible 120px box, so the geometry stays believable while
    // the marker lands on an element nobody can see. `data-active` is the same
    // thing CSS sticky keys off, so this cannot disagree with what the browser
    // pinned. The main checkout has no tab in this lane, so it selects nothing
    // here and needs no separate guard.
    const lane = nav.querySelector<HTMLElement>('[data-workspace-lane="true"]');
    const activeTab = nav.querySelector<HTMLElement>(
      '[data-workspace-tab="true"][data-active="true"]',
    );
    const activeTabWidth = activeTab?.offsetWidth ?? 0;
    const activeTabNaturalLeft = activeTab
      ? workspaceTabNaturalOffsetLeft(activeTab)
      : 0;
    const lead = nav.querySelector<HTMLElement>(
      '[data-top-bar-pinned-lead="true"]',
    );
    // Grouped pins the pill one lead-slot in from the leading edge and flush at
    // the trailing one. Read off the LANE MODE, not off the lead element:
    // GROUPED_WORKSPACE_STICKY_INSET_CLS is on every Grouped tab, so that is
    // the inset the browser is using whether or not a lead is rendered yet.
    const leadingInset = groupedLane
      ? WORKSPACE_GROUPED_LEADING_INSET_PX
      : WORKSPACE_STICKY_EDGE_INSET_PX;
    const pinSide = activeTab
      ? workspacePinSide({
          scrollLeft: nav.scrollLeft,
          scrollWidth: nav.scrollWidth,
          clientWidth: nav.clientWidth,
          tabOffsetLeft: activeTabNaturalLeft,
          tabWidth: activeTabWidth,
          edgeInset: WORKSPACE_STICKY_EDGE_INSET_PX,
          leadingInset,
        })
      : null;

    // The lead resolves its OWN side against its OWN insets rather than
    // inheriting the pill's, because the two genuinely differ. Two sticky
    // siblings with scrollable content between them cannot be made to park
    // simultaneously AND adjacently at both edges; closing the gap on one side
    // opens it on the other. What the insets buy is the LEADING edge, where the
    // pill's reserved slot means an unpinned lead would leave a hole: there the
    // lead parks first and holds, as a group header, until its pill joins it.
    // At the trailing edge the order reverses, so a selection deeper in its own
    // repository keeps the pill parked while the icon rejoins its flow slot —
    // acceptable only because the icon is on screen throughout (asserted in
    // workspace-tabs.test.ts), never lost.
    const leadTrailingInset = workspacePinnedLeadTrailingInset({
      edgeInset: WORKSPACE_STICKY_EDGE_INSET_PX,
      tabWidth: activeTabWidth,
      gap: WORKSPACE_TAB_GAP_PX,
    });
    nav.style.setProperty(
      WORKSPACE_PINNED_LEAD_RIGHT_VAR,
      `${leadTrailingInset}px`,
    );
    const leadPinSide: WorkspacePinSide =
      activeTab && lead
        ? workspacePinSide({
            scrollLeft: nav.scrollLeft,
            scrollWidth: nav.scrollWidth,
            clientWidth: nav.clientWidth,
            tabOffsetLeft: workspaceTabNaturalOffsetLeft(lead),
            tabWidth: lead.offsetWidth,
            edgeInset: WORKSPACE_STICKY_EDGE_INSET_PX,
            trailingInset: leadTrailingInset,
          })
        : null;

    setLanePinMarker(lane, WORKSPACE_PIN_ATTR, pinSide);
    setLanePinMarker(lane, WORKSPACE_PIN_LEAD_ATTR, leadPinSide);

    const fades = workspaceFadeVisibility(overflow, pinSide, leadPinSide);
    // The pinned unit is whatever of [lead][pill] actually parked at THAT edge;
    // the fades belong immediately outside it, never under it.
    const fadeOffsets = workspacePinnedFadeOffsets({
      clientWidth: nav.clientWidth,
      tabWidth: activeTabWidth,
      edgeInset: WORKSPACE_STICKY_EDGE_INSET_PX,
      leadSlot: WORKSPACE_PINNED_LEAD_SLOT_PX,
      fadeWidth: WORKSPACE_FADE_WIDTH_PX,
      pinSide,
      leadPinSide,
    });

    // Scroll events can outpace React renders. Update only the lightweight
    // overlay styles here so the browser-owned sticky tab and its masks stay
    // on the same frame even during a fast trackpad fling.
    setWorkspaceFadeVisible(workspaceOuterLeftFadeRef.current, fades.outerLeft);
    setWorkspaceFadeVisible(
      workspaceOuterRightFadeRef.current,
      fades.outerRight,
    );
    placeWorkspaceFade(
      workspaceAfterPinnedLeftFadeRef.current,
      fades.afterPinnedLeft,
      fadeOffsets.afterPinnedLeft,
    );
    placeWorkspaceFade(
      workspaceBeforePinnedRightFadeRef.current,
      fades.beforePinnedRight,
      fadeOffsets.beforePinnedRight,
    );
  }, [groupedLane]);

  const syncWorkspaceStrip = useCallback(() => {
    measureWorkspaceStrip();
    retargetWorkspaceHover();
  }, [measureWorkspaceStrip, retargetWorkspaceHover]);

  // A presentation switch starts its strip at the leading edge. This runs before
  // the measuring effect so no stale scroll position reaches the next paint.
  useLayoutEffect(() => {
    if (workspaceNavRef.current) workspaceNavRef.current.scrollLeft = 0;
  }, [workspaceListFilter]);

  // Identity, not just count: archiving one workspace while another is created
  // in the same commit swaps a tab element without moving the length, and the
  // replacement would otherwise never get a resize subscription.
  const workspaceTabIdentity = useMemo(
    () => navItems.map((item) => item.key).join(","),
    [navItems],
  );

  // FLIP only the Active lane: layout publishes the correct order immediately,
  // then compositor transforms briefly carry surviving tabs from their prior
  // slots. No opacity, delayed data, or reserved animation space.
  useLayoutEffect(() => {
    const positions = new Map<string, number>();
    for (const item of navItems) {
      if (item.kind === "project") continue;
      const key =
        item.kind === "workspace" ? item.workspace.id : item.pending.token;
      const node = workspaceTabRefs.current.get(key);
      if (node) positions.set(key, workspaceTabNaturalOffsetLeft(node));
    }

    const previous = workspaceReorderSnapshotRef.current;
    const animations = workspaceReorderAnimationsRef.current;
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (workspaceListFilter !== "active" || reducedMotion) {
      for (const animation of animations.values()) animation.cancel();
      animations.clear();
    } else if (previous?.filter === "active") {
      for (const [key, nextLeft] of positions) {
        const priorLeft = previous.positions.get(key);
        const node = workspaceTabRefs.current.get(key);
        if (priorLeft === undefined || !node) continue;
        const delta = priorLeft - nextLeft;
        if (Math.abs(delta) < 0.5 || typeof node.animate !== "function") {
          continue;
        }
        animations.get(key)?.cancel();
        const animation = node.animate(
          [
            { transform: `translate3d(${delta}px, 0, 0)` },
            { transform: "translate3d(0, 0, 0)" },
          ],
          {
            duration: WORKSPACE_REORDER_DURATION_MS,
            easing: "ease-out",
            fill: "both",
          },
        );
        animations.set(key, animation);
        animation.onfinish = () => {
          if (animations.get(key) !== animation) return;
          animation.cancel();
          animations.delete(key);
        };
      }
    }
    for (const [key, animation] of animations) {
      if (positions.has(key)) continue;
      animation.cancel();
      animations.delete(key);
    }
    workspaceReorderSnapshotRef.current = {
      filter: workspaceListFilter,
      positions,
    };
  }, [navItems, workspaceListFilter]);

  useEffect(
    () => () => {
      for (const animation of workspaceReorderAnimationsRef.current.values()) {
        animation.cancel();
      }
      workspaceReorderAnimationsRef.current.clear();
    },
    [],
  );

  // Recalculate masks when the window or tab content changes. Observing both
  // boxes covers responsive widths, async workspace loads, and icon changes.
  // The active tab itself is always CSS-sticky, so it never waits for this JS.
  //
  // Each TAB is observed too, not just the lane. Tabs are content-sized, so a
  // ± pair landing on one workspace while another's clears can leave the lane's
  // total width identical — the lane's own box never resizes and a lane-only
  // observer would sleep through it, leaving the pin decision and the pinned
  // fades placed against stale offsets. Per-tab boxes cannot cancel out.
  // Re-running on tab identity keeps the observed set current across archive,
  // create, and optimistic → confirmed replacement. A tab that merely changes
  // its contents keeps its element, and its subscription with it.
  useLayoutEffect(() => {
    const nav = workspaceNavRef.current;
    if (!nav) return;
    syncWorkspaceStrip();
    const frame = window.requestAnimationFrame(syncWorkspaceStrip);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(syncWorkspaceStrip);
    observer?.observe(nav);
    const lane = nav.firstElementChild;
    if (lane) {
      observer?.observe(lane);
      for (const tab of lane.querySelectorAll('[data-workspace-tab="true"]')) {
        observer?.observe(tab);
      }
    }
    window.addEventListener("resize", syncWorkspaceStrip);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", syncWorkspaceStrip);
    };
    // The measure pass reads the selected tab and the repository lead out of the
    // DOM, so it has no dependency on either — but it still has to RUN when
    // they change, or the lane keeps a marker describing the previous
    // selection. Tab identity misses both: reselecting inside one repository
    // changes neither the tab list nor its order.
  }, [
    activeWorkspaceTabKey,
    liveLoading,
    pinnedLeadProjectId,
    workspaceTabIdentity,
    syncWorkspaceStrip,
  ]);

  // Dashboard cards and newly-created chats can activate a workspace without
  // focusing its top-bar button. Reveal its natural slot before paint; native
  // sticky positioning would otherwise fool scrollIntoView into doing nothing.
  useLayoutEffect(() => {
    if (!activeWorkspaceTabKey || activeWorkspaceTabKey === mainWorkspace?.id)
      return;
    const nav = workspaceNavRef.current;
    const activeTab = workspaceTabRefs.current.get(activeWorkspaceTabKey);
    if (!nav || !activeTab) return;
    const targetScrollLeft = workspaceScrollLeftForTab({
      scrollLeft: nav.scrollLeft,
      scrollWidth: nav.scrollWidth,
      clientWidth: nav.clientWidth,
      tabOffsetLeft: workspaceTabNaturalOffsetLeft(activeTab),
      tabWidth: activeTab.offsetWidth,
      edgeInset: WORKSPACE_CONTENT_INSET_PX,
      // Reveal ONTO the sticky inset the pill will occupy. Landing it on the
      // bare content inset instead would leave sticky pushing the freshly
      // revealed pill a lead-slot to the right, over its own neighbour.
      leadingInset: groupedLane
        ? WORKSPACE_GROUPED_LEADING_INSET_PX
        : WORKSPACE_CONTENT_INSET_PX,
    });
    if (Math.abs(nav.scrollLeft - targetScrollLeft) > 0.5) {
      nav.scrollLeft = targetScrollLeft;
    }
    syncWorkspaceStrip();
  }, [
    activeWorkspaceTabKey,
    groupedLane,
    mainWorkspace?.id,
    // A filter switch restarts the strip at the leading edge (above). Identity
    // alone can miss that: Ungrouped and Active can publish the SAME keys in
    // the same order, which left the selected tab off-screen after the reset.
    workspaceListFilter,
    workspaceTabIdentity,
    syncWorkspaceStrip,
  ]);

  /** A repository-only selection and its restored workspace publish together.
   * Grouped/Ungrouped/Active are metadata-only and normal workspace opens
   * preserve them; the reducer handles cross-repository opens from lists. */
  const handleSelectFilter = useCallback(
    (nextFilter: WorkspaceListFilter) => {
      const projectId = workspaceListFilterProjectId(nextFilter);
      const project = projectId
        ? (projects.find((candidate) => candidate.id === projectId) ?? null)
        : null;
      if (
        !project ||
        activePage !== "workspace" ||
        activeProject?.id === project.id
      ) {
        dispatch({ type: "SET_WORKSPACE_LIST_FILTER", filter: nextFilter });
        return;
      }
      const state = useWorkspaceStore.getState();
      openWorkspace(
        resolveRepoWorkspaceDestination({
          project,
          rememberedFolder: selectLastWorkspaceFolderForRepo(
            state,
            project.repoRoot,
          ),
          cachedWorkspaces: peekWorkspacesFor(project.repoSlug),
          allowLocalMain: workInLocalMain,
        }),
        { workspaceListFilter: nextFilter },
      );
    },
    [
      activePage,
      activeProject?.id,
      dispatch,
      openWorkspace,
      projects,
      workInLocalMain,
    ],
  );

  const handleSelectWorkspace = useCallback(
    (workspace: Workspace) => {
      trackWorkspaceOpened({
        isWorktree: !isLocalMainWorkspace(workspace),
        status: workspace.status,
      });
      openWorkspace(workspace);
    },
    [openWorkspace],
  );

  const handlePrefetchWorkspace = useCallback(
    (workspace: Workspace) => {
      // Design rows are ordinary destinations, so warm the surface for them
      // too — but never their coding chat.
      prefetchWorkspaceSurface(workspace);
      if (workspace.kind === "design") {
        return;
      }
      const chatId = selectChatToRestoreForFolder(
        useWorkspaceStore.getState(),
        workspace.path,
      );
      if (chatId) {
        void sessions.hydrateChat(chatId);
        prepareChatView(chatId);
      }
    },
    [sessions],
  );

  const pendingOnly =
    pendingProject &&
    !projects.some((project) => project.repoRoot === pendingProject.root)
      ? pendingProject
      : null;
  const homeActive =
    activePage === "dashboard" ||
    activePage === "customize" ||
    activePage === "settings" ||
    activePage === "repo";
  const displayMainWorkspace = useMemo(
    () =>
      filterProject
        ? (withLocalMainWorkspace(
            filterProject,
            realWorkspaces.filter(
              (workspace) => workspace.repoRoot === filterProject.repoRoot,
            ),
          )[0] ?? null)
        : null,
    [filterProject, realWorkspaces],
  );
  const mainTabVisible = workInLocalMain && !!displayMainWorkspace;
  const mainActive =
    mainTabVisible && activeWorkspaceId === displayMainWorkspace.id;
  const stripHasTabs = navItems.length > 0;
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);

  // The 40px title rail — h-10 is its TOTAL painted height, hairline included.
  // `pt-px` is what centers the row: the 1px border-b would otherwise make the
  // rail 40px of chrome whose 28px controls center in the 39px above the
  // hairline, so every control sat half a pixel high and the gap under it read
  // a pixel longer than the gap over it. (It was worse still with the former
  // `box-content`, which pushed the hairline outside the box for a 41px rail
  // centered as 40.) One pixel of top padding balances the border, so the
  // controls land on the rail's own center line with 6px of rail above and 6px
  // below — and on macOS, where the window-edge stroke covers the rail's FIRST
  // pixel row (titleBarStyle hiddenInset + rounded corners) exactly as the
  // hairline covers its LAST, the visible gaps match too.
  //
  // The hairline stays a real border rather than an inset shadow so the
  // workspace strip's opaque z-30 edge gutters (below) cannot paint over it:
  // they are inset-y-0 inside this content box, which the border sits outside.
  return (
    <header
      ref={topBarRef}
      className="border-border1 bg-sidebar-bg flex h-10 w-full shrink-0 items-center overflow-hidden border-b pt-px"
      aria-label="Workspace navigation"
    >
      {/* Native macOS traffic-light reserve. Its empty width provides the
          boundary without adding a divider to the borderless navigation row. */}
      <div className="h-full w-[85px] shrink-0" aria-hidden="true" />
      <div className={TOP_BAR_LEADING_ACTIONS_CLS}>
        {/* Home tab — entry to the Home surface (Dashboard / repo pages /
            Settings, switched via the HomeSidebar). Stays lit across every
            sub-page; returning from a workspace restores the last one. */}
        <Tooltip label="Home" side="bottom">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={ICON_BUTTON_CLS}
            data-active={homeActive}
            aria-current={homeActive ? "page" : undefined}
            aria-label="Home"
            onClick={() => dispatch({ type: "OPEN_HOME" })}
          >
            <Home className="size-4" strokeWidth={1.5} />
          </Button>
        </Tooltip>
        <Tooltip label="Create workspace" side="bottom">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={ICON_BUTTON_CLS}
            data-active={activePage === "create"}
            aria-current={activePage === "create" ? "page" : undefined}
            aria-label="Create workspace"
            onClick={() => openDispatcher(contextProject?.id)}
          >
            <Plus className="size-4" strokeWidth={1.5} />
          </Button>
        </Tooltip>
        <DropdownMenu open={filterMenuOpen} onOpenChange={setFilterMenuOpen}>
          <Tooltip label="Filter workspaces" side="bottom">
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={MENU_ICON_BUTTON_CLS}
                data-active={filterMenuOpen}
                aria-label="Filter workspaces"
              >
                <ListFilter className="size-4" strokeWidth={1.5} />
              </Button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="start" sideOffset={5} className="w-56">
            {(["grouped", "ungrouped", "active"] as const).map((filter) => (
              <DropdownMenuItem
                key={filter}
                onSelect={() => handleSelectFilter(filter)}
                aria-current={
                  workspaceListFilter === filter ? "true" : undefined
                }
              >
                <span>
                  {filter === "grouped"
                    ? "Grouped"
                    : filter === "ungrouped"
                      ? "Ungrouped"
                      : "Active"}
                </span>
                {workspaceListFilter === filter && (
                  <Check className="text-fg2 ml-auto size-3.5" />
                )}
              </DropdownMenuItem>
            ))}
            {projects.length > 0 && <DropdownMenuSeparator />}
            {projects.map((project) => {
              const filter = repositoryWorkspaceListFilter(project.id);
              const selected = workspaceListFilter === filter;
              return (
                <DropdownMenuItem
                  key={project.id}
                  className="min-w-0"
                  onPointerEnter={() => {
                    prefetchProjectWorkspaceDestination(project);
                    prefetchSettingsForRepo(project.repoRoot);
                  }}
                  onFocus={() => {
                    prefetchProjectWorkspaceDestination(project);
                    prefetchSettingsForRepo(project.repoRoot);
                  }}
                  onSelect={() => handleSelectFilter(filter)}
                  aria-current={selected ? "true" : undefined}
                >
                  <ProjectIconChip
                    project={project}
                    opening={openingRoot === project.repoRoot}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {project.name}
                  </span>
                  {selected && <Check className="text-fg2 ml-auto size-3.5" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <TopBarBoundary
        showSeparator={navigationBoundarySeparatorVisible(
          homeActive || activePage === "create",
          false,
        )}
      />

      {filterProject && (
        <div className={TOP_BAR_ITEM_CLS}>
          <ProjectMarker
            project={filterProject}
            openingRoot={openingRoot}
            compact={false}
          />
        </div>
      )}

      {!filterProject && pendingOnly ? (
        <div
          className="text-fg2 flex h-7 min-w-0 shrink-0 items-center gap-2 rounded-md px-2.5 text-xs"
          role="status"
          aria-live="polite"
        >
          <ZerosSpinner size={14} label={`Opening ${pendingOnly.name}`} />
          <span className="max-w-48 truncate">{pendingOnly.name}</span>
        </div>
      ) : null}

      {/* Experimental Local main remains fixed in a repository-only view.
          Once the row fills, only the workspace lane shrinks and scrolls. */}
      <div className="flex h-full min-w-0 flex-1 items-stretch">
        {mainTabVisible && displayMainWorkspace && (
          <>
            {filterProject && (
              <TopBarBoundary
                showSeparator={navigationBoundarySeparatorVisible(
                  false,
                  mainActive,
                )}
              />
            )}
            <div className={TOP_BAR_ITEM_CLS}>
              <Button
                type="button"
                variant="ghost"
                size="default"
                className={MAIN_TAB_CLS}
                aria-current={mainActive ? "page" : undefined}
                aria-label="Open main checkout"
                data-active={mainActive}
                onPointerEnter={() =>
                  handlePrefetchWorkspace(displayMainWorkspace)
                }
                onFocus={() => handlePrefetchWorkspace(displayMainWorkspace)}
                onClick={() => handleSelectWorkspace(displayMainWorkspace)}
              >
                <span
                  className="inline-flex size-4 shrink-0 items-center justify-center"
                  aria-hidden="true"
                >
                  <LaptopMinimal className="size-3.5" strokeWidth={1.25} />
                </span>
                {LOCAL_MAIN_LABEL}
              </Button>
            </div>
          </>
        )}

        {stripHasTabs && (
          <div className="relative h-full min-w-0 shrink overflow-hidden">
            <nav
              ref={workspaceNavRef}
              className="h-full min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              aria-label={
                filterProject
                  ? `${filterProject.name} workspaces`
                  : workspaceListFilter === "grouped"
                    ? "Workspaces grouped by repository"
                    : workspaceListFilter === "active"
                      ? "Workspaces ordered by recent activity"
                      : "Workspaces"
              }
              aria-busy={liveLoading || undefined}
              onScroll={syncWorkspaceStrip}
              onPointerEnter={handleWorkspacePointer}
              onPointerMove={handleWorkspacePointer}
              onPointerLeave={clearWorkspacePointer}
              onPointerCancel={clearWorkspacePointer}
              onWheelCapture={handleWorkspaceWheel}
            >
              {/* Boundary carriers own the four-pixel spacing. gap-0 prevents
                  flex spacing from double-counting them; px-0 keeps the first
                  carrier itself as the exact sticky/content inset. */}
              {/* `group/lane` is the pin markers' carrier: the measure pass
                  writes data-workspace-pin / -lead here and the pinned pill and
                  its repository lead style off it. */}
              <div
                className="group/lane relative flex h-full w-max items-center gap-0 px-0"
                data-workspace-lane="true"
              >
                {navItems.map((item, index) => {
                  const groupedRepository = workspaceListFilter === "grouped";
                  const active =
                    item.kind === "workspace"
                      ? activeWorkspaceTabKey === item.workspace.id
                      : item.kind === "pending"
                        ? activeWorkspaceTabKey === item.pending.token
                        : false;
                  const previous = navItems[index - 1];
                  const next = navItems[index + 1];
                  const leftActive = previous
                    ? previous.kind === "workspace"
                      ? activeWorkspaceTabKey === previous.workspace.id
                      : previous.kind === "pending"
                        ? activeWorkspaceTabKey === previous.pending.token
                        : false
                    : mainActive;
                  const groupEnd =
                    groupedRepository &&
                    item.kind !== "project" &&
                    (!next || next.kind === "project");
                  // Every repository begins with its icon, so a project item is
                  // a group start by construction. `index > 0` keeps the lane's
                  // leading carrier at the sticky/content inset instead of
                  // indenting the whole strip by the wider group gap.
                  const groupGap =
                    groupedRepository && item.kind === "project" && index > 0;
                  return (
                    <React.Fragment key={item.key}>
                      <TopBarBoundary
                        edge={index === 0}
                        groupedBackground={
                          groupedRepository && item.kind !== "project"
                        }
                        groupGap={groupGap}
                        suppressSeparator={groupedRepository}
                        showSeparator={navigationBoundarySeparatorVisible(
                          leftActive,
                          active,
                        )}
                      />
                      {item.kind === "project" ? (
                        <ProjectMarker
                          project={item.project}
                          openingRoot={openingRoot}
                          compact={item.compact}
                          grouped={groupedRepository}
                          pinnedLead={item.project.id === pinnedLeadProjectId}
                          onSelect={(project) =>
                            handleSelectFilter(
                              repositoryWorkspaceListFilter(project.id),
                            )
                          }
                        />
                      ) : item.kind === "workspace" ? (
                        <WorkspaceTab
                          workspace={item.workspace}
                          project={item.project}
                          mixedRepositories={isMixedWorkspaceListFilter(
                            workspaceListFilter,
                          )}
                          groupedRepository={groupedRepository}
                          groupEnd={groupEnd}
                          active={active}
                          chatIds={
                            chatIdsByWorkspace.get(item.workspace.id) ?? []
                          }
                          onSelect={handleSelectWorkspace}
                          onPrefetch={handlePrefetchWorkspace}
                          onArchive={(target) => void archiveWorkspace(target)}
                          tabRef={(node) =>
                            registerWorkspaceTab(item.workspace.id, node)
                          }
                        />
                      ) : (
                        <PendingWorkspaceTab
                          kind={item.pending.kind}
                          project={item.project}
                          mixedRepositories={isMixedWorkspaceListFilter(
                            workspaceListFilter,
                          )}
                          groupedRepository={groupedRepository}
                          groupEnd={groupEnd}
                          label={
                            item.pending.branch
                              ? branchDisplayName(item.pending.branch)
                              : "New workspace"
                          }
                          active={active}
                          tabRef={(node) =>
                            registerWorkspaceTab(item.pending.token, node)
                          }
                        />
                      )}
                    </React.Fragment>
                  );
                })}
                {/* The removed per-repository plus leaves only this trailing
                    four-pixel content inset. */}
                <TopBarBoundary showSeparator={false} />
              </div>
            </nav>

            {/* The active tab is above every fade. At its pinned edge the normal
              outer fade relocates immediately after/before the tab. Opaque
              four-pixel gutters keep scrolling labels out of the edge gap. */}
            <div
              ref={workspaceOuterLeftFadeRef}
              className="from-sidebar-bg pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r to-transparent opacity-0"
              aria-hidden="true"
            />
            <div
              ref={workspaceOuterRightFadeRef}
              className="from-sidebar-bg pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l to-transparent opacity-0"
              aria-hidden="true"
            />
            <div
              ref={workspaceAfterPinnedLeftFadeRef}
              className="from-sidebar-bg pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r to-transparent opacity-0 will-change-transform"
              aria-hidden="true"
            />
            <div
              ref={workspaceBeforePinnedRightFadeRef}
              className="from-sidebar-bg pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-l to-transparent opacity-0 will-change-transform"
              aria-hidden="true"
            />
            <div
              className="bg-sidebar-bg pointer-events-none absolute inset-y-0 left-0 z-30 w-1"
              aria-hidden="true"
            />
            <div
              className="bg-sidebar-bg pointer-events-none absolute inset-y-0 right-0 z-30 w-1"
              aria-hidden="true"
            />
          </div>
        )}

        <div className="min-w-0 flex-1" aria-hidden="true" />
      </div>

      {/* gap-1 remains correct when ResourceMonitor is unavailable and returns
          null: React leaves only Archive in this flex row, so no phantom
          second gap appears during native-runtime startup. */}
      <div className="flex h-full shrink-0 items-center gap-1">
        <ResourceMonitor />

        <div className={TOP_BAR_TRAILING_ITEM_CLS}>
          {contextProject ? (
            <ArchivedWorkspacePicker
              key={contextProject.id}
              project={contextProject}
            />
          ) : (
            <Tooltip
              label="Select a repository to view archived workspaces"
              side="bottom"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={MENU_ICON_BUTTON_CLS}
                aria-label="Archived workspaces"
                disabled
              >
                <Archive className="size-3.5" strokeWidth={1.5} />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
    </header>
  );
}
