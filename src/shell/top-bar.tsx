// ============================================
// COMPONENT: TopBar
// PURPOSE: Global project and workspace navigation after removing Column 1.
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
  ChevronDown,
  ClipboardList,
  GitBranch,
  GitMergeConflict,
  GitPullRequestArrow,
  GitPullRequestClosed,
  Home,
  ImageIcon,
  LaptopMinimal,
  MessageCircleQuestionMark,
  Plus,
  Settings,
} from "lucide-react";

import { type Workspace } from "../native/git";
import { usePrIslandKind } from "./pr/pr-island-state-store";
import { getSetting, setSetting } from "../native/settings";
import { useNativeRuntime } from "../native/runtime";
import { trackWorkspaceOpened } from "../zeros/analytics/agent-events";
import { useAgentSessions } from "../zeros/agent/sessions-hooks";
import {
  useAnyChatAwaitingKind,
  useAnyChatStreaming,
} from "../zeros/agent/sessions-store";
import {
  isLocalMainWorkspace,
  LOCAL_MAIN_LABEL,
  withLocalMainWorkspace,
} from "../zeros/store/local-main-workspace";
import {
  pruneWorktreePhantomProjects,
  type Project,
} from "../zeros/store/projects-store";
import { DEFAULT_REPO_SETTINGS_VIEW } from "../zeros/panels/repo-page";
import {
  selectActiveFolder,
  selectChatToRestoreForFolder,
  selectLastWorkspaceFolderForRepo,
  useActivePage,
  useActiveRepoId,
  useChats,
  useWorkspaceDispatch,
  useWorkspaceStore,
} from "../zeros/store/store";
import {
  restoreWorkspaceWithFeedback,
  useArchiveWorkspace,
} from "../zeros/store/archive-actions";
import { useOpenWorkspace } from "../zeros/store/use-open-workspace";
import {
  notifyProjectsChanged,
  peekWorkspacesFor,
  prefetchWorkspacesFor,
  useArchivedWorkspaces,
  useProjects,
  useSyncProjectsToEngine,
  useWorkspacesFor,
} from "../zeros/store/use-projects";
import {
  dedupePendingCreates,
  selectLiveVisible,
} from "../zeros/store/live-workspace-selectors";
import {
  prefetchSettingsForRepo,
  usePrefetchSettings,
} from "../zeros/settings/use-settings";
import {
  findProjectForFolder,
  findWorkspaceForFolder,
} from "../zeros/store/workspace-resolution";
import { Button } from "../zeros/ui/primitives/button";
import {
  Command,
  CommandInput,
  CommandList,
} from "../zeros/ui/primitives/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../zeros/ui/primitives/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../zeros/ui/primitives/context-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../zeros/ui/primitives/popover";
import {
  isExperimentalEnabled,
  useExperimentalFeature,
} from "../zeros/settings/experimental-features";
import { createWorkspaceForProject } from "./create-workspace";
import { toast } from "../zeros/ui/primitives/elements";
import { Tooltip } from "../zeros/ui/primitives/tooltip";
import { RepositoryIcon } from "../zeros/ui/repository-icon";
import { WorkspaceContextMenu } from "../zeros/ui/workspace-context-menu";
import { formatCompactAge } from "../zeros/agent/format-age";
import { RunWave, ZerosSpinner } from "../loaders";
import { useAddProject } from "./add-project-provider";
import {
  useAnyRunActionRunning,
  useWorkspaceRunActivitySync,
} from "./terminal/run-activity-store";
import {
  usePendingCreatesAll,
  usePendingCreatesFor,
  useWorkspaceArchiving,
  useWorkspaceProvisioning,
} from "../zeros/store/pending-workspaces";
import { prefetchWorkspaceSurface } from "./prefetch-workspace-surface";
import { prepareColumn2ChatView } from "./column2-chat-intent";
import { warmWorkspaceFiles } from "./workspace-files-cache";
import { RepositoryIconDialog } from "./repository-icon-dialog";
import {
  filterArchivedWorkspaces,
  horizontalOverflow,
  orderWorkspaceTabs,
  resolveRepoWorkspaceDestination,
  workspaceFadeVisibility,
  workspaceLabel,
  workspacePinSide,
  workspaceScrollLeftForTab,
  workspaceTabDescription,
} from "./top-bar-helpers";
import { useCustomWindowDrag } from "./use-custom-window-drag";
import { useWorkspaceChangeLines } from "./use-workspace-change-lines";
import { WorkspaceChangeCounts } from "./workspace-change-counts";

// --- CONSTANTS ---

const SELECTED_PROJECT_KEY = "zeros.top-bar.selected-project";

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
      // it must agree with the destination handleSelectProject will pick.
      allowLocalMain: isExperimentalEnabled("workInLocalMain"),
    }),
  );
}

// Fills its cell edge to edge: the hover/selected wash spans the full 40px row
// rather than sitting inside it as a rounded chip. `h-full` beats size="icon"'s
// h-7, `rounded-none` beats the Button base's rounded-sm, and w-9 reproduces the
// 36px the cell used to occupy as a 28px button inside 4px of wrapper padding —
// so the fill grows without the bar's horizontal rhythm moving. The cell
// wrappers drop that px-1 to match; keep the two in step.
//
// Home and main answer the same question a selected workspace tab answers —
// "which surface is this window showing?" — so their selected state is the
// --bg1 canvas, and hovering an already-selected one repaints that same --bg1
// rather than lifting it. Identical rule, and identical reasoning, to
// WORKSPACE_TAB_CLS; the compound hover variant carries an extra attribute
// selector, so it outranks the plain hover rule whatever order Tailwind emits
// them in.
const ICON_BUTTON_CLS =
  "h-full w-9 shrink-0 rounded-none text-fg2 hover:bg-sidebar-bg-hover hover:text-fg1 data-[active=true]:bg-bg1 data-[active=true]:text-fg1 data-[active=true]:hover:bg-bg1";
// Same cell geometry, different meaning: the archived picker's `data-active` is
// "my dropdown is open", a transient press, not a selection. It keeps the
// sidebar hover wash — painting it --bg1 would read as a permanently selected
// surface on a control that never owns one.
const MENU_ICON_BUTTON_CLS =
  "h-full w-9 shrink-0 rounded-none text-fg2 hover:bg-sidebar-bg-hover hover:text-fg1 data-[active=true]:bg-sidebar-bg-hover data-[active=true]:text-fg1";
// The plus keeps the ORIGINAL inset chip: size="icon"'s 28px square with the
// Button base's rounded-sm, centred in 4px of wrapper padding. It is the one
// control here that is never "selected" — there is no state for a full-bleed
// wash to represent — so filling its cell would read as a permanently lit tab.
const INSET_ICON_BUTTON_CLS =
  "shrink-0 text-fg2 hover:bg-sidebar-bg-hover hover:text-fg1";
// Main carries a visible "main" label so it reads as a named tab beside the
// branch tabs rather than a bare glyph. It is a full-bleed cell like the icon
// buttons above — same h-full, same rounded-none, same --bg1 selected wash,
// because it answers the same "which surface is this window showing?" question
// a selected workspace tab does. Its metrics follow WORKSPACE_TAB_CLS (px-3,
// gap-2.5, text-xs, 3.5 icon) so "main" sits on the branch names' rhythm.
//
// Spelled out rather than interpolating ICON_BUTTON_CLS: that class now carries
// a fixed `w-9`, and the label needs the width to follow the content. Overriding
// it would put `w-9` and `w-auto` at equal specificity and let stylesheet order
// decide — the same race the pin borders go inline to avoid. With no `w-*` here
// at all, the Button base's own `w-fit` sizes the cell to the label.
const MAIN_TAB_CLS =
  "h-full shrink-0 justify-start gap-2.5 rounded-none px-3 text-xs text-fg2 transition-none hover:bg-sidebar-bg-hover hover:text-fg1 data-[active=true]:bg-bg1 data-[active=true]:text-fg1 data-[active=true]:hover:bg-bg1 [&_svg]:size-3.5";
// The app window bottoms out at 800px. Interpolate through the constrained
// 800–1200px band, then hold the requested default/max widths above it.
const PROJECT_TRIGGER_CLS =
  "w-[clamp(100px,calc(10vw_+_20px),140px)] min-w-[100px] max-w-[140px] shrink-0 justify-start gap-2 border-0 bg-transparent px-2 text-xs text-fg2 shadow-none hover:bg-sidebar-bg-hover hover:text-fg1 data-[state=open]:bg-sidebar-bg-hover data-[state=open]:text-fg1";
const PROJECT_CHIP_CLS =
  "inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-bg2-hover text-xxs font-medium text-fg2";
// Content-sized, not a fixed ramp: the tab is as wide as its icon + name +
// whatever trailing indicators it happens to carry, floored at 120px and capped
// at 180px. NO `w-*` — a width would defeat the intrinsic sizing, and every
// child except the name is shrink-0, so the cap spends itself truncating the
// branch name and never the ± pair or the wave.
// Full-bleed selection: h-full + no radius means the hover/selected wash covers
// the whole 40px cell, matching the icon cells either side of the strip. The
// tabs sit flush (the lane has no gap or padding) and a left hairline separates
// them, which is the divider convention the rest of this bar already uses.
// The SELECTED tab paints --bg1 — the app canvas, not a sidebar hover wash — so
// it reads as continuous with the content below it, and hover/focus repaint the
// same --bg1 rather than lifting it. Those two compound variants carry an extra
// attribute selector, so they outrank the plain hover rule on specificity and
// win no matter what order Tailwind emits them in.
// Sticky insets are 0 to match the lane's zero padding: a pinned tab sits flush
// against the main cell's border on one side and the plus cell's on the other,
// which is what lets measureWorkspaceStrip give it a single hairline per edge
// instead of stacking one against a neighbour's.
// The label weight lives HERE, on the container both tab variants share, not
// on the inner Button — `buttonVariants` bakes in `font-medium`, so a real tab
// got 500 while the pending placeholder (a bare div, no Button) inherited the
// body's 400 and visibly thickened the moment the create landed. Declaring it
// once on the shared class is what the chat strip does (TAB_BASE_CLS in
// column2-chat-tabs.tsx) and is why that strip has never had the same snap.
const WORKSPACE_TAB_CLS =
  "group/workspace border-border1 relative flex h-full min-w-[120px] max-w-[180px] shrink-0 select-none items-center overflow-hidden border-l px-3 text-left text-xs font-medium text-fg2 transition-none first:border-l-0 focus-within:bg-sidebar-bg-hover focus-within:text-fg2 data-[hovered=true]:bg-sidebar-bg-hover data-[hovered=true]:text-fg2 data-[active=true]:sticky data-[active=true]:left-0 data-[active=true]:right-0 data-[active=true]:z-20 data-[active=true]:bg-bg1 data-[active=true]:text-fg1 data-[active=true]:focus-within:bg-bg1 data-[active=true]:focus-within:text-fg1 data-[active=true]:data-[hovered=true]:bg-bg1 data-[active=true]:data-[hovered=true]:text-fg1";
// `flex-auto`, never `flex-1`: flex-1 pins the basis at 0, which would erase
// this button's contents from the tab's intrinsic width and collapse every tab
// onto the 120px floor. `w-auto` undoes the Button base's `w-fit` for the same
// reason. Keep this free of any `font-*` — the weight is inherited.
const WORKSPACE_OPEN_BUTTON_CLS =
  "h-full w-auto min-w-0 flex-auto justify-start gap-2.5 border-0 bg-transparent p-0 text-left text-xs text-inherit shadow-none transition-none hover:bg-transparent hover:text-inherit [&_svg]:size-3.5";
// The gradient has to start in whatever colour the tab underneath it is, or the
// archive affordance reads as a coloured band. A hovered tab is sidebar-bg-hover
// EXCEPT when it is also the selected one, which now paints --bg1 — hence the
// group-scoped override.
const WORKSPACE_ACTION_OVERLAY_CLS =
  "pointer-events-none absolute inset-y-0 right-0 flex w-10 items-center justify-end bg-gradient-to-l from-sidebar-bg-hover from-50% to-transparent pr-1 opacity-0 transition-none group-data-[hovered=true]/workspace:opacity-100 group-data-[active=true]/workspace:from-bg1 focus-within:opacity-100";
const WORKSPACE_ACTION_CLS =
  "pointer-events-auto inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-fg2 transition-[background-color,color] duration-120 ease-out hover:bg-bg2-hover hover:text-fg1";
// The strip runs flush into the controls on either side: no lane padding, so a
// tab's edge meets the main cell's border-r on the left and the plus cell's
// border-l on the right with nothing between them. Both insets are therefore 0
// — the first tab starts at x=0, and a pinned tab pins to the very edge, which
// is what puts its border exactly against the neighbouring cell's. (These used
// to be 4, guarded by opaque gutters that covered the padding so scrolling
// labels could not leak into it; with no padding there is nothing to cover and
// the gutters are gone.) They stay named and separate from the tab gap because
// the edge inset and the space between tabs are still distinct decisions.
const WORKSPACE_CONTENT_INSET_PX = 0;
const WORKSPACE_STICKY_EDGE_INSET_PX = 0;
// MUST mirror the `gap-*` on the tab strip below (gap-0 → 0). A sticky tab's
// own offsetLeft is clamped, so workspaceTabNaturalOffsetLeft rebuilds its
// true flow position from the previous tab plus this gap; a value that drifts
// from the class silently offsets the pin and fade placement by the delta.
// Zero because the tabs now sit flush and a border-l on each one draws the
// divider. That border is INSIDE offsetWidth (border-box), so the walk still
// lands exactly on the next tab — which is precisely why the separator has to
// stay a border and never become an element between tabs.
// Deliberately NOT the edge inset above — the strip's outer padding and the
// space between tabs are separate decisions.
const WORKSPACE_TAB_GAP_PX = 0;
const WORKSPACE_FADE_WIDTH_PX = 24;

/** A pinned tab has to read as bordered on BOTH edges without any seam ever
 *  doubling up. At the edge it is pinned to it sits flush against a cell that
 *  already draws a line there — the main checkout's border-r on the left, the
 *  plus cell's border-l on the right — so the tab drops its OWN border on that
 *  side and draws the opposite one, which it otherwise lacks (tabs carry only a
 *  border-l). One hairline per edge, from whichever element owns it.
 *
 *  Inline widths rather than classes, for two reasons: pin state is recomputed
 *  on every scroll frame with no React render (same reason the fades are placed
 *  imperatively), and an inline width cannot lose a specificity race with
 *  `first:border-l-0` when the first tab is the pinned one. */
function applyWorkspacePinBorders(
  tab: HTMLDivElement | null,
  pinSide: "left" | "right" | null,
): void {
  if (!tab) return;
  // The border COLOUR comes from the tab's own `border-border1`; only width and
  // style are set here. Style matters: an unset side defaults to `none`, so a
  // width alone would draw nothing.
  const drawLeft = pinSide === "right";
  const drawRight = pinSide === "left";
  const style = tab.style;
  const leftWidth = pinSide === null ? "" : drawLeft ? "1px" : "0px";
  const rightWidth = pinSide === null ? "" : drawRight ? "1px" : "0px";
  const sideStyle = pinSide === null ? "" : "solid";
  if (style.borderLeftWidth !== leftWidth) style.borderLeftWidth = leftWidth;
  if (style.borderRightWidth !== rightWidth)
    style.borderRightWidth = rightWidth;
  if (style.borderLeftStyle !== sideStyle) style.borderLeftStyle = sideStyle;
  if (style.borderRightStyle !== sideStyle) style.borderRightStyle = sideStyle;
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
 * Chromium. The preceding non-sticky tab still exposes the active tab's true
 * flow position, including while the active tab is pinned at either edge. */
function workspaceTabNaturalOffsetLeft(tab: HTMLDivElement): number {
  let sibling = tab.previousElementSibling;
  while (sibling) {
    if (
      sibling instanceof HTMLDivElement &&
      sibling.dataset.workspaceTab === "true"
    ) {
      return sibling.offsetLeft + sibling.offsetWidth + WORKSPACE_TAB_GAP_PX;
    }
    sibling = sibling.previousElementSibling;
  }
  return WORKSPACE_CONTENT_INSET_PX;
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
 * builds. It used to live inside Column 1 and must survive that component's
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

/** Keep the native-runtime failure explanation mounted now that Column 1 no
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
  /** Live chat ids in this worktree, used for agent activity state. */
  chatIds: readonly string[];
  /** Opens the workspace and restores or creates its chat. */
  onSelect: (workspace: Workspace) => void;
  /** Warms the exact chat/tree/file destination on pointer or keyboard intent. */
  onPrefetch: (workspace: Workspace) => void;
  /** Archives the worktree without selecting it first. */
  onArchive: (workspace: Workspace) => void;
  /** Registers the tab so the active workspace can be revealed on navigation. */
  tabRef?: (node: HTMLDivElement | null) => void;
}

// --- CHILD COMPONENTS ---

/** The idle tab glyph for a workspace WITH a PR (2026-07-19): the icon tracks
 *  the PR's live island state — brown PR-arrow while open, red conflict glyph
 *  on merge conflicts, green PR-arrow when ready to merge, a violet mirrored
 *  branch when merged, and a red closed glyph when closed. Falls back to the
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
      // The flip of the default branch glyph — "work flowed back in".
      return (
        <GitBranch
          className="text-violet-fg size-3.5 -scale-x-100"
          strokeWidth={1.25}
        />
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

function WorkspaceTab({
  workspace,
  active,
  chatIds,
  onSelect,
  onPrefetch,
  onArchive,
  tabRef,
}: WorkspaceTabProps) {
  const streaming = useAnyChatStreaming(chatIds);
  const awaitingKind = useAnyChatAwaitingKind(chatIds);
  const islandKind = usePrIslandKind(workspace.id, workspace.prNumber);
  const runActionRunning = useAnyRunActionRunning(workspace.path);
  const changeLines = useWorkspaceChangeLines(workspace);
  const label = workspaceLabel(workspace);
  const archiving = useWorkspaceArchiving(workspace.id);

  const tab = (
    <div
      ref={tabRef}
      className={WORKSPACE_TAB_CLS}
      data-active={active}
      data-workspace-tab="true"
      data-streaming={streaming || undefined}
      aria-busy={archiving || undefined}
    >
      <Button
        type="button"
        variant="ghost"
        size="default"
        className={WORKSPACE_OPEN_BUTTON_CLS}
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
        <span
          className="inline-flex size-4 shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          {archiving ? (
            <ZerosSpinner size={16} label="Archiving workspace" />
          ) : awaitingKind === "plan" ? (
            <ClipboardList className="size-3.5" strokeWidth={1.25} />
          ) : awaitingKind === "input" ? (
            <MessageCircleQuestionMark
              className="size-3.5"
              strokeWidth={1.25}
            />
          ) : streaming ? (
            <ZerosSpinner size={16} variant="agent" label="Agent working" />
          ) : (
            (prTabIcon(workspace, islandKind) ?? (
              <GitBranch className="size-3.5" strokeWidth={1.25} />
            ))
          )}
        </span>
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
      {!archiving && (
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
      archiveDisabled={archiving}
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
  active = false,
}: {
  label: string;
  active?: boolean;
}) {
  return (
    <div
      className={WORKSPACE_TAB_CLS}
      data-workspace-tab="true"
      data-active={active}
      role="status"
      aria-live="polite"
    >
      <span
        className="inline-flex size-4 shrink-0 items-center justify-center"
        aria-hidden="true"
      >
        <GitBranch className="size-3.5" strokeWidth={1.25} />
      </span>
      <span className="ml-2.5 min-w-0 flex-auto truncate text-left">
        {label}
      </span>
    </div>
  );
}

interface ProjectPickerProps {
  /** Repository currently supplying the workspace tabs. */
  selectedProject: Project;
  /** Every repository available to switch into. */
  projects: Project[];
  /** Repository root currently undergoing a native open/reconnect. */
  openingRoot: string | null;
  /** Updates repository context and, when appropriate, app content. */
  onSelect: (project: Project) => void;
  /** Opens the Dispatcher scoped to the selected repository. */
  onCreate: () => void;
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

function ProjectPicker({
  selectedProject,
  projects,
  openingRoot,
  onSelect,
  onCreate,
}: ProjectPickerProps) {
  const selectedOpening = openingRoot === selectedProject.repoRoot;
  const [iconDialogOpen, setIconDialogOpen] = useState(false);
  // Context-menu navigation to the repo page's Settings tab.
  const dispatch = useWorkspaceDispatch();

  return (
    <>
      <div className="flex min-w-0 items-center">
        <ContextMenu>
          <DropdownMenu>
            <ContextMenuTrigger
              asChild
              onContextMenu={positionMenuBelowTrigger}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="default"
                  className={PROJECT_TRIGGER_CLS}
                  aria-label={`Switch repository: ${selectedProject.name}`}
                >
                  <ProjectIconChip
                    project={selectedProject}
                    opening={selectedOpening}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {selectedProject.name}
                  </span>
                  <ChevronDown className="ml-auto size-2.5" strokeWidth={1.5} />
                </Button>
              </DropdownMenuTrigger>
            </ContextMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={5}
              className="w-max max-w-72 min-w-[var(--radix-dropdown-menu-trigger-width)]"
            >
              <DropdownMenuItem onSelect={() => window.setTimeout(onCreate, 0)}>
                <Plus />
                <span>Create</span>
              </DropdownMenuItem>
              {projects.map((project) => {
                const selected = project.id === selectedProject.id;
                return (
                  <DropdownMenuItem
                    key={project.id}
                    onPointerEnter={() => {
                      prefetchProjectWorkspaceDestination(project);
                      prefetchSettingsForRepo(project.repoRoot);
                    }}
                    onFocus={() => {
                      prefetchProjectWorkspaceDestination(project);
                      prefetchSettingsForRepo(project.repoRoot);
                    }}
                    onSelect={() => onSelect(project)}
                    aria-current={selected ? "true" : undefined}
                    className="min-w-0"
                  >
                    <ProjectIconChip
                      project={project}
                      opening={openingRoot === project.repoRoot}
                    />
                    <span className="max-w-52 min-w-0 flex-1 truncate">
                      {project.name}
                    </span>
                    {selected && (
                      <Check
                        className="text-fg2 ml-auto size-3.5"
                        strokeWidth={1.5}
                      />
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          <ContextMenuContent className="w-48">
            <ContextMenuItem
              onSelect={() =>
                window.setTimeout(() => setIconDialogOpen(true), 0)
              }
            >
              <ImageIcon />
              <span>Change icon</span>
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                dispatch({
                  type: "OPEN_REPO_PAGE",
                  projectId: selectedProject.id,
                  view: DEFAULT_REPO_SETTINGS_VIEW,
                });
              }}
            >
              <Settings />
              <span>Repository Settings</span>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>

      <RepositoryIconDialog
        project={selectedProject}
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
  const { workspaces, loading, error, refresh } = useArchivedWorkspaces(
    project.repoSlug,
  );

  const allForProject = useMemo(
    () => filterArchivedWorkspaces(workspaces, project.repoSlug, ""),
    [project.repoSlug, workspaces],
  );
  const matches = useMemo(
    () => filterArchivedWorkspaces(workspaces, project.repoSlug, query),
    [project.repoSlug, query, workspaces],
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
  const activePage = useActivePage();
  const activeRepoId = useActiveRepoId();
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

  // Stores the repository context while the Dashboard is active, where the
  // current chat folder intentionally remains unchanged in the background.
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    () => getSetting<string | null>(SELECTED_PROJECT_KEY, null),
  );
  // The whole row is a native window drag target except for its interactive
  // descendants, which useCustomWindowDrag excludes automatically.
  const topBarRef = useRef<HTMLElement | null>(null);
  useCustomWindowDrag(topBarRef);

  const storedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const routedRepoProject = useMemo(
    () =>
      activePage === "repo"
        ? (projects.find((project) => project.id === activeRepoId) ?? null)
        : null,
    [activePage, activeRepoId, projects],
  );
  // Workspace content and visible tabs must agree. Dashboard has no active
  // workspace content, so it is free to retain an independently picked repo.
  const selectedProject =
    activePage === "workspace" && activeProject
      ? activeProject
      : (routedRepoProject ??
        storedProject ??
        activeProject ??
        projects[0] ??
        null);

  const persistSelectedProject = useCallback((projectId: string | null) => {
    setSelectedProjectId(projectId);
    setSetting(SELECTED_PROJECT_KEY, projectId);
  }, []);

  useEffect(() => {
    const resolvedId = selectedProject?.id ?? null;
    if (resolvedId !== selectedProjectId) persistSelectedProject(resolvedId);
  }, [persistSelectedProject, selectedProject?.id, selectedProjectId]);

  const { workspaces, loading, refreshing } = useWorkspacesFor(
    selectedProject?.repoSlug ?? null,
  );

  // "Work in local main" (Settings → Experimental, off by default). This gates
  // the main TAB and where a repo switch lands — never the synthetic row
  // itself: `mainWorkspace` still backs active-tab resolution for repo-root
  // chats, the bounce-to-main safety net, and the delete/remove escape hatches.
  // Dropping it from `visibleWorkspaces` would strand those paths instead.
  const [workInLocalMain] = useExperimentalFeature("workInLocalMain");

  const visibleWorkspaces = useMemo(
    () =>
      selectedProject
        ? withLocalMainWorkspace(selectedProject, workspaces)
        : [],
    [selectedProject, workspaces],
  );
  // File indexes are the most visible cold-workspace waterfall. Warm a bounded
  // window only after the repository list settles and the browser is idle;
  // pointer/focus intent still handles the exact file/diff/chat destination.
  useEffect(() => {
    if (loading || visibleWorkspaces.length === 0) return;
    const targets = visibleWorkspaces.slice(0, 8);
    const warm = () => {
      for (const workspace of targets) warmWorkspaceFiles(workspace.path);
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm, { timeout: 1_000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 0);
    return () => window.clearTimeout(id);
  }, [loading, visibleWorkspaces]);
  const mainWorkspace = visibleWorkspaces[0] ?? null;
  // In-flight creates across all repos — used both to render pending tabs and to
  // protect a slow-create's announced path from the bounce-to-main effect.
  const allPendingCreates = usePendingCreatesAll();
  const realWorkspaces = useMemo(
    () =>
      orderWorkspaceTabs(
        // Shared selector (same one the Dashboard/repo hub/sidebar use) — drops
        // only confirmed archived rows. An in-flight row stays here, inert with
        // its spinner, until the engine confirms the destructive transition.
        // visibleWorkspaces[0] is synthetic Local main; keep it out of the strip.
        selectLiveVisible(visibleWorkspaces.slice(1)),
      ),
    [visibleWorkspaces],
  );
  useWorkspaceRunActivitySync(realWorkspaces);

  // A cold repository switch is allowed to publish its remembered folder
  // before the workspace list settles. Only a completed exact-key snapshot may
  // invalidate that identity; when it proves the worktree was deleted, move to
  // main as a new authoritative navigation (never as an initial-cache guess).
  useEffect(() => {
    if (
      activePage !== "workspace" ||
      !activeFolder ||
      !selectedProject ||
      activeProject?.id !== selectedProject.id ||
      activeFolder === selectedProject.repoRoot ||
      loading ||
      refreshing ||
      peekWorkspacesFor(selectedProject.repoSlug) === undefined
    ) {
      return;
    }
    if (
      (mainWorkspace &&
        findWorkspaceForFolder(activeFolder, [mainWorkspace])) ||
      findWorkspaceForFolder(activeFolder, workspaces)
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
    // this guard cannot be held by Column 3's separate presentation settling.
    if (activeFolderProvisioning) return;
    // A slow create (past the ~60s settling cap) whose real row hasn't landed
    // yet must not be bounced to main — its placeholder create is still in
    // flight, so the announced path is legitimate even though it isn't listed.
    if (allPendingCreates.some((c) => c.path === activeFolder)) return;
    openWorkspace(
      resolveRepoWorkspaceDestination({
        project: selectedProject,
        rememberedFolder: activeFolder,
        cachedWorkspaces: workspaces,
        allowLocalMain: workInLocalMain,
      }),
    );
  }, [
    activeFolder,
    activeFolderProvisioning,
    activePage,
    activeProject?.id,
    allPendingCreates,
    dispatch,
    loading,
    mainWorkspace,
    openWorkspace,
    refreshing,
    selectedProject,
    workInLocalMain,
    workspaces,
  ]);

  const chatIdsByWorkspace = useMemo(() => {
    const liveChats = chats.filter((chat) => !chat.archived);
    const ids = new Map<string, string[]>();
    for (const workspace of realWorkspaces) {
      ids.set(
        workspace.id,
        liveChats
          .filter((chat) => findWorkspaceForFolder(chat.folder, [workspace]))
          .map((chat) => chat.id),
      );
    }
    return ids;
  }, [chats, realWorkspaces]);

  const activeWorkspaceId = useMemo(() => {
    if (
      activePage !== "workspace" ||
      !activeFolder ||
      !selectedProject ||
      !mainWorkspace
    ) {
      return null;
    }
    const engineWorkspace = findWorkspaceForFolder(
      activeFolder,
      realWorkspaces,
    );
    if (engineWorkspace) return engineWorkspace.id;
    // Reuse the normalized folder resolver for `/private/var` ↔ `/var` and
    // chats rooted in a subdirectory of main. A raw prefix check would leave
    // the main icon inactive for those otherwise-valid paths.
    const insideMainCheckout = !!findWorkspaceForFolder(activeFolder, [
      mainWorkspace,
    ]);
    return insideMainCheckout ? mainWorkspace.id : null;
  }, [
    activeFolder,
    activePage,
    mainWorkspace,
    realWorkspaces,
    selectedProject,
  ]);

  const workspaceNavRef = useRef<HTMLElement | null>(null);
  const workspaceTabRefs = useRef(new Map<string, HTMLDivElement>());
  /** The tab currently carrying inline pinned borders, so it can be cleared
   *  when the pin moves off it. See applyWorkspacePinBorders. */
  const workspacePinnedTabRef = useRef<HTMLDivElement | null>(null);
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

    const activeId = activeWorkspaceId;
    const activeTab = activeId ? workspaceTabRefs.current.get(activeId) : null;
    const activeTabWidth = activeTab?.offsetWidth ?? 0;
    const activeTabNaturalLeft = activeTab
      ? workspaceTabNaturalOffsetLeft(activeTab)
      : 0;
    const pinSide =
      activeId && activeId !== mainWorkspace?.id && activeTab
        ? workspacePinSide({
            scrollLeft: nav.scrollLeft,
            scrollWidth: nav.scrollWidth,
            clientWidth: nav.clientWidth,
            tabOffsetLeft: activeTabNaturalLeft,
            tabWidth: activeTabWidth,
            edgeInset: WORKSPACE_STICKY_EDGE_INSET_PX,
          })
        : null;
    const fades = workspaceFadeVisibility(overflow, pinSide);

    // Retire the previous carrier before styling the new one. The tab that owns
    // the pinned borders changes when the selection moves, when the strip stops
    // overflowing, and when a pinned workspace is archived out from under us —
    // each of which would otherwise strand inline borders on a tab that is no
    // longer pinned, giving it a permanent extra hairline.
    const pinnedTab = pinSide ? (activeTab ?? null) : null;
    if (
      workspacePinnedTabRef.current &&
      workspacePinnedTabRef.current !== pinnedTab
    ) {
      applyWorkspacePinBorders(workspacePinnedTabRef.current, null);
    }
    workspacePinnedTabRef.current = pinnedTab;
    applyWorkspacePinBorders(pinnedTab, pinSide);

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
      WORKSPACE_STICKY_EDGE_INSET_PX + activeTabWidth,
    );
    placeWorkspaceFade(
      workspaceBeforePinnedRightFadeRef.current,
      fades.beforePinnedRight,
      Math.max(
        0,
        nav.clientWidth -
          WORKSPACE_STICKY_EDGE_INSET_PX -
          activeTabWidth -
          WORKSPACE_FADE_WIDTH_PX,
      ),
    );
  }, [activeWorkspaceId, mainWorkspace?.id]);

  const syncWorkspaceStrip = useCallback(() => {
    measureWorkspaceStrip();
    retargetWorkspaceHover();
  }, [measureWorkspaceStrip, retargetWorkspaceHover]);

  // A repository switch starts its strip at the leading edge. This runs before
  // the measuring effect so no stale scroll position reaches the next paint.
  useLayoutEffect(() => {
    if (workspaceNavRef.current) workspaceNavRef.current.scrollLeft = 0;
  }, [selectedProject?.id]);

  // Identity, not just count: archiving one workspace while another is created
  // in the same commit swaps a tab element without moving the length, and the
  // replacement would otherwise never get a resize subscription.
  const workspaceTabIdentity = useMemo(
    () => realWorkspaces.map((workspace) => workspace.id).join(","),
    [realWorkspaces],
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
  // Re-running on the tab COUNT is enough to keep the observed set current:
  // React keys tabs by workspace id / create token, so a tab that merely
  // changes its contents keeps its element, and its subscription with it.
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
      for (const tab of lane.children) observer?.observe(tab);
    }
    window.addEventListener("resize", syncWorkspaceStrip);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", syncWorkspaceStrip);
    };
  }, [loading, workspaceTabIdentity, syncWorkspaceStrip]);

  // Dashboard cards and newly-created chats can activate a workspace without
  // focusing its top-bar button. Reveal its natural slot before paint; native
  // sticky positioning would otherwise fool scrollIntoView into doing nothing.
  useLayoutEffect(() => {
    if (!activeWorkspaceId || activeWorkspaceId === mainWorkspace?.id) return;
    const nav = workspaceNavRef.current;
    const activeTab = workspaceTabRefs.current.get(activeWorkspaceId);
    if (!nav || !activeTab) return;
    const targetScrollLeft = workspaceScrollLeftForTab({
      scrollLeft: nav.scrollLeft,
      scrollWidth: nav.scrollWidth,
      clientWidth: nav.clientWidth,
      tabOffsetLeft: workspaceTabNaturalOffsetLeft(activeTab),
      tabWidth: activeTab.offsetWidth,
      edgeInset: WORKSPACE_CONTENT_INSET_PX,
    });
    if (Math.abs(nav.scrollLeft - targetScrollLeft) > 0.5) {
      nav.scrollLeft = targetScrollLeft;
    }
    syncWorkspaceStrip();
  }, [
    activeWorkspaceId,
    mainWorkspace?.id,
    realWorkspaces.length,
    syncWorkspaceStrip,
  ]);

  /** Repository switching restores the destination owned by that surface: a
   * workspace route reopens the repo's remembered worktree, a repo route opens
   * that repo's remembered hub tab, and Dashboard/Settings only change context. */
  const handleSelectProject = useCallback(
    (project: Project) => {
      persistSelectedProject(project.id);
      if (activePage === "repo") {
        if (activeRepoId !== project.id) {
          dispatch({ type: "OPEN_REPO_PAGE", projectId: project.id });
        }
        return;
      }
      if (activePage !== "workspace" || activeProject?.id === project.id) {
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
      );
    },
    [
      activePage,
      activeProject?.id,
      activeRepoId,
      dispatch,
      openWorkspace,
      persistSelectedProject,
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
      prefetchWorkspaceSurface(workspace);
      const chatId = selectChatToRestoreForFolder(
        useWorkspaceStore.getState(),
        workspace.path,
      );
      if (chatId) {
        void sessions.hydrateChat(chatId);
        prepareColumn2ChatView(chatId);
      }
    },
    [sessions],
  );

  /** Create directly in the selected repository, then move into the new
   * workspace. The global plus remains the richer Dispatcher entry point.
   * The optimistic flow itself lives in ./create-workspace, shared with the
   * repo-add paths that now open a workspace instead of the trunk. */
  const handleCreateWorkspace = useCallback(async () => {
    if (!selectedProject) return;
    await createWorkspaceForProject({ project: selectedProject, dispatch });
  }, [dispatch, selectedProject]);

  // Pending creates for the visible repository — one "Setting up workspace…"
  // tab each, from ANY create surface (this plus or the Dispatcher).
  const pendingCreates = usePendingCreatesFor(
    selectedProject?.repoSlug ?? null,
  );
  // Whether the strip renders anything at all — a real tab or an optimistic
  // placeholder. Drives the plus cell's divider; see its comment at that cell.
  const stripHasTabs =
    realWorkspaces.length > 0 ||
    dedupePendingCreates(pendingCreates, realWorkspaces).length > 0;
  const pendingOnly =
    pendingProject &&
    !projects.some((project) => project.repoRoot === pendingProject.root)
      ? pendingProject
      : null;

  return (
    <header
      ref={topBarRef}
      className="border-border1 bg-sidebar-bg box-content flex h-10 w-full shrink-0 items-center overflow-hidden border-b"
      aria-label="Workspace navigation"
    >
      {/* Native macOS traffic-light reserve. Keep its separator independent
          from the application actions so Home never visually merges with the
          window controls. */}
      <div
        className="border-border1 h-full w-[85px] shrink-0 border-r"
        aria-hidden="true"
      />
      <div className="border-border1 flex h-full shrink-0 items-center border-r">
        {/* Home tab — entry to the Home surface (Dashboard / repo pages /
            Settings, switched via the HomeSidebar). Stays lit across every
            sub-page; returning from a workspace restores the last one. */}
        <Tooltip label="Home" side="bottom">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={ICON_BUTTON_CLS}
            data-active={
              activePage === "dashboard" ||
              activePage === "customize" ||
              activePage === "settings" ||
              activePage === "repo"
            }
            aria-current={
              activePage === "dashboard" ||
              activePage === "customize" ||
              activePage === "settings" ||
              activePage === "repo"
                ? "page"
                : undefined
            }
            aria-label="Home"
            onClick={() => dispatch({ type: "OPEN_HOME" })}
          >
            <Home className="size-4" strokeWidth={1.5} />
          </Button>
        </Tooltip>
      </div>

      {selectedProject ? (
        <div className="border-border1 flex h-full shrink-0 items-center border-r px-1">
          <ProjectPicker
            selectedProject={selectedProject}
            projects={projects}
            openingRoot={openingRoot}
            onSelect={handleSelectProject}
            onCreate={() => openDispatcher(selectedProject.id)}
          />
        </div>
      ) : pendingOnly ? (
        <div
          className="border-border1 text-fg2 flex h-full min-w-0 shrink-0 items-center gap-2 border-r px-3 text-xs"
          role="status"
          aria-live="polite"
        >
          <ZerosSpinner size={14} label={`Opening ${pendingOnly.name}`} />
          <span className="max-w-48 truncate">{pendingOnly.name}</span>
        </div>
      ) : null}

      {/* Main remains fixed and is separated from the workspace tabs. The tab
          strip sizes to its contents while there is room, keeping the plus
          directly after the final tab. Once the row fills, only the workspace
          nav shrinks and scrolls; the plus remains pinned without a divider. */}
      <div className="flex h-full min-w-0 flex-1 items-stretch">
        {workInLocalMain && mainWorkspace && (
          <div className="border-border1 flex h-full shrink-0 items-center border-r">
            <Button
              type="button"
              variant="ghost"
              size="default"
              className={MAIN_TAB_CLS}
              aria-current={
                activeWorkspaceId === mainWorkspace.id ? "page" : undefined
              }
              aria-label="Open main checkout"
              data-active={activeWorkspaceId === mainWorkspace.id}
              onPointerEnter={() => handlePrefetchWorkspace(mainWorkspace)}
              onFocus={() => handlePrefetchWorkspace(mainWorkspace)}
              onClick={() => handleSelectWorkspace(mainWorkspace)}
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
        )}

        <div className="relative h-full min-w-0 shrink overflow-hidden">
          <nav
            ref={workspaceNavRef}
            className="h-full min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            aria-label={
              selectedProject
                ? `${selectedProject.name} workspaces`
                : "Workspaces"
            }
            aria-busy={loading || undefined}
            onScroll={syncWorkspaceStrip}
            onPointerEnter={handleWorkspacePointer}
            onPointerMove={handleWorkspacePointer}
            onPointerLeave={clearWorkspacePointer}
            onPointerCancel={clearWorkspacePointer}
            onWheelCapture={handleWorkspaceWheel}
          >
            {/* gap-0 is paired with WORKSPACE_TAB_GAP_PX — change both. Tabs
                are flush; their border-l draws the divider. */}
            <div className="relative flex h-full w-max items-center gap-0 px-0">
              {realWorkspaces.map((workspace) => (
                <WorkspaceTab
                  key={workspace.id}
                  workspace={workspace}
                  active={activeWorkspaceId === workspace.id}
                  chatIds={chatIdsByWorkspace.get(workspace.id) ?? []}
                  onSelect={handleSelectWorkspace}
                  onPrefetch={handlePrefetchWorkspace}
                  onArchive={(target) => void archiveWorkspace(target)}
                  tabRef={(node) => registerWorkspaceTab(workspace.id, node)}
                />
              ))}
              {/* Optimistic creates: one placeholder tab per in-flight
                  workspace.create so the click has a visible result THIS
                  frame; replaced by the real tab when the RPC lands (the
                  branch filter hides the placeholder the moment the real row
                  reaches the list, so the tab never doubles). Active when the
                  user was navigated to its announced path. */}
              {dedupePendingCreates(pendingCreates, realWorkspaces).map(
                (pending) => (
                  <PendingWorkspaceTab
                    key={pending.token}
                    label={
                      pending.branch
                        ? pending.branch.startsWith("zeros/")
                          ? pending.branch.slice("zeros/".length)
                          : pending.branch
                        : "New workspace"
                    }
                    active={!!pending.path && pending.path === activeFolder}
                  />
                ),
              )}
            </div>
          </nav>

          {/* The active tab is above every fade. At its pinned edge the normal
              outer fade relocates immediately after/before the tab. There are
              no opaque edge gutters any more: they existed only to keep
              scrolling labels out of the lane's 4px padding, and the lane is
              now flush against the controls either side. */}
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
        </div>

        {/* The divider belongs to the strip/plus seam, so it only exists when
            there is a strip to divide from. With no tabs at all the lane
            collapses to zero width and this border would land flush against
            the main cell's border-r — one visual seam drawn twice. */}
        {selectedProject && (
          <div
            className={
              stripHasTabs
                ? "border-border1 flex h-full shrink-0 items-center border-l px-1"
                : "flex h-full shrink-0 items-center px-1"
            }
          >
            {/* Always the plain plus — never a spinner/disabled swap. Every
                click reserves an independent workspace, while the optimistic
                tab + navigation provide immediate per-click feedback. */}
            <Tooltip label="New workspace" side="bottom">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={INSET_ICON_BUTTON_CLS}
                aria-label="New workspace"
                onClick={() => void handleCreateWorkspace()}
              >
                <Plus className="size-4" strokeWidth={1.5} />
              </Button>
            </Tooltip>
          </div>
        )}

        <div className="min-w-0 flex-1" aria-hidden="true" />
      </div>

      <div className="border-border1 flex h-full shrink-0 items-center border-l">
        {selectedProject ? (
          <ArchivedWorkspacePicker
            key={selectedProject.id}
            project={selectedProject}
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
    </header>
  );
}
