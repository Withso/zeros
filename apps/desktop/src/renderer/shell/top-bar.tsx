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
  ChevronDown,
  ClipboardList,
  GitBranch,
  GitMerge,
  GitMergeConflict,
  GitPullRequestArrow,
  GitPullRequestClosed,
  Home,
  ImageIcon,
  LaptopMinimal,
  MessageCircleQuestionMark,
  PenTool,
  Plus,
  Settings,
} from "lucide-react";

import { type Workspace } from "../platform/git";
import { usePrIslandKind } from "./pr/pr-island-state-store";
import { getSetting, setSetting } from "../platform/settings";
import { useNativeRuntime } from "../platform/runtime";
import { trackWorkspaceOpened } from "../platform/observability/analytics/agent-events";
import { useAgentSessions } from "../features/agent/sessions-hooks";
import {
  useAnyChatAwaitingKind,
  useAnyChatStreaming,
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
  useActiveRepoId,
  useChats,
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
  useProjects,
  useSyncProjectsToEngine,
  useWorkspacesFor,
} from "../state/use-projects";
import {
  dedupePendingCreates,
  filterPendingCreatesForDesignAccess,
  filterWorkspacesForDesignAccess,
  selectLiveVisible,
} from "../state/live-workspace-selectors";
import {
  prefetchSettingsForRepo,
  usePrefetchSettings,
} from "../features/settings/use-settings";
import {
  findProjectForFolder,
  findWorkspaceForFolder,
  resolveWorkspacePresentationKind,
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
import { useInternalFeatureActive } from "../features/settings/internal-features";
import { useActiveOrganization } from "../features/team/team-store";
import { filterRowsForOrganization } from "../features/team/organization-capabilities";
import { createWorkspaceForProject } from "./create-workspace";
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
  usePendingCreatesFor,
  usePendingWorkspaceKind,
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
  orderWorkspaceTabs,
  resolveRepoWorkspaceDestination,
  workspaceFadeVisibility,
  workspaceLabel,
  workspacePinSide,
  workspaceScrollLeftForTab,
  workspaceTabDescription,
} from "./workspace-tabs";
import { branchDisplayName } from "../shared/lib/branch-name";
import { useCustomWindowDrag } from "./use-custom-window-drag";
import { useWorkspaceChangeLines } from "./use-workspace-change-lines";
import { WorkspaceChangeCounts } from "./workspace-change-counts";
import { ResourceMonitor } from "./resource-monitor";
import { cn } from "../shared/ui/cn";

// --- CONSTANTS ---

const SELECTED_PROJECT_KEY = "zeros.top-bar.selected-project";

/** Warm the exact workspace a repository switch will restore. This works even
 * while the repository's workspace-list key is cold because the persisted
 * folder itself is already a complete local navigation identity. */
function prefetchProjectWorkspaceDestination(
  project: Project,
  designWorkspacesActive: boolean,
): void {
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
      allowDesignWorkspaces: designWorkspacesActive,
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
// The plus remains the existing compact 28px action rather than a destination.
const INSET_ICON_BUTTON_CLS =
  "shrink-0 text-fg2 hover:bg-sidebar-bg-hover hover:text-fg1";
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
// `flex-auto`, never `flex-1`: flex-1 pins the basis at 0, which would erase
// this button's contents from the tab's intrinsic width and collapse every tab
// onto the 120px floor. `w-auto` undoes the Button base's `w-fit` for the same
// reason. Keep this free of any `font-*` — the weight is inherited.
const WORKSPACE_OPEN_BUTTON_CLS =
  "h-full w-auto min-w-0 flex-auto justify-start gap-2.5 border-0 bg-transparent p-0 text-left text-xs text-inherit shadow-none transition-none hover:bg-transparent hover:text-inherit [&_svg]:size-3.5";
// Hover and selection share the same opaque pill fill, so one gradient serves
// both archive-overlay states without a hard band behind the icon.
const WORKSPACE_ACTION_OVERLAY_CLS =
  "pointer-events-none absolute inset-y-0 right-0 flex w-10 items-center justify-end bg-gradient-to-l from-sidebar-bg-hover from-50% to-transparent pr-1 opacity-0 transition-none group-data-[hovered=true]/workspace:opacity-100 focus-within:opacity-100";
const WORKSPACE_ACTION_CLS =
  "pointer-events-auto inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-fg2 transition-[background-color,color] duration-120 ease-out hover:bg-bg2-hover hover:text-fg1";
// One four-pixel carrier owns every top-bar boundary. Its optional 1×14px
// hairline is centered inside that width, so showing or hiding the separator
// never changes spacing. The leading carrier in the workspace lane also keeps
// the first tab aligned with the selected pill's left-1/right-1 sticky inset.
const TOP_BAR_BOUNDARY_CLS =
  "pointer-events-none flex h-full w-1 shrink-0 items-center justify-center";
const TOP_BAR_SEPARATOR_CLS = "bg-border1 h-[14px] w-px";
const TOP_BAR_ITEM_CLS = "flex h-full shrink-0 items-center";
const TOP_BAR_LEADING_ITEM_CLS = "flex h-full shrink-0 items-center pl-1";
const TOP_BAR_TRAILING_ITEM_CLS = "flex h-full shrink-0 items-center pr-1";
const WORKSPACE_CONTENT_INSET_PX = 4;
const WORKSPACE_STICKY_EDGE_INSET_PX = 4;
// MUST mirror TOP_BAR_BOUNDARY_CLS's w-1. The strip itself is gap-0: one
// carrier sits before each tab, so a sticky tab's natural position is the
// previous tab's right edge plus this width. A separate flex gap would count
// twice and silently offset pin/fade placement.
const WORKSPACE_TAB_GAP_PX = 4;
const WORKSPACE_FADE_WIDTH_PX = 24;

function TopBarBoundary({
  showSeparator,
  edge = false,
}: {
  showSeparator: boolean;
  /** Let the leading line paint above the opaque sticky-edge gutter. */
  edge?: boolean;
}) {
  return (
    <span
      className={cn(TOP_BAR_BOUNDARY_CLS, edge && "relative z-40")}
      data-top-bar-boundary="true"
      aria-hidden="true"
    >
      <span
        className={cn(TOP_BAR_SEPARATOR_CLS, !showSeparator && "invisible")}
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

function WorkspaceTab({
  workspace,
  active,
  chatIds,
  onSelect,
  onPrefetch,
  onArchive,
  tabRef,
}: WorkspaceTabProps) {
  const designWorkspace = workspace.kind === "design";
  const agentChatIds = designWorkspace ? EMPTY_WORKSPACE_CHAT_IDS : chatIds;
  const streaming = useAnyChatStreaming(agentChatIds);
  const awaitingKind = useAnyChatAwaitingKind(agentChatIds);
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
      data-streaming={(!designWorkspace && streaming) || undefined}
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
          ) : designWorkspace ? (
            <PenTool className="size-3.5" strokeWidth={1.25} />
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
  kind = "code",
  active = false,
  tabRef,
}: {
  label: string;
  kind?: "code" | "design";
  active?: boolean;
  /** Registers the optimistic tab with the same sticky/reveal machinery. */
  tabRef?: (node: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={tabRef}
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
        {kind === "design" ? (
          <PenTool className="size-3.5" strokeWidth={1.25} />
        ) : (
          <GitBranch className="size-3.5" strokeWidth={1.25} />
        )}
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
  /** Effective Internal gate used by intent prefetch and route restoration. */
  designWorkspacesActive: boolean;
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
  designWorkspacesActive,
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
                      prefetchProjectWorkspaceDestination(
                        project,
                        designWorkspacesActive,
                      );
                      prefetchSettingsForRepo(project.repoRoot);
                    }}
                    onFocus={() => {
                      prefetchProjectWorkspaceDestination(
                        project,
                        designWorkspacesActive,
                      );
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
  const designWorkspacesActive = useInternalFeatureActive("designWorkspaces");
  const activeOrganization = useActiveOrganization();
  const { workspaces, loading, error, refresh } = useArchivedWorkspaces(
    project.repoSlug,
  );
  const accessibleWorkspaces = useMemo(
    () =>
      filterRowsForOrganization(
        filterWorkspacesForDesignAccess(workspaces, designWorkspacesActive),
        activeOrganization,
      ),
    [activeOrganization, designWorkspacesActive, workspaces],
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
  const activePage = useActivePage();
  const activeRepoId = useActiveRepoId();
  const nativeRuntime = useNativeRuntime();
  const designWorkspacesInternalActive =
    useInternalFeatureActive("designWorkspaces");
  const designWorkspacesActive =
    designWorkspacesInternalActive &&
    (nativeRuntime.ready || nativeRuntime.expectedElectron);
  const activeOrganization = useActiveOrganization();
  const activeFolder = useWorkspaceStore(selectActiveFolder);
  // True while the active folder is a freshly-announced worktree whose create
  // is still landing — the list-validation effect below must not bounce it.
  const activeFolderProvisioning = useWorkspaceProvisioning(activeFolder);
  const activeFolderPendingKind = usePendingWorkspaceKind(activeFolder);
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

  const accessibleWorkspaces = useMemo(
    () =>
      filterRowsForOrganization(
        filterWorkspacesForDesignAccess(workspaces, designWorkspacesActive),
        activeOrganization,
      ),
    [activeOrganization, designWorkspacesActive, workspaces],
  );
  const activeFolderConfirmedWorkspace = useMemo(
    () => findWorkspaceForFolder(activeFolder, workspaces),
    [activeFolder, workspaces],
  );
  const activeFolderBlockedDesign =
    !designWorkspacesActive &&
    resolveWorkspacePresentationKind({
      confirmedKind: activeFolderConfirmedWorkspace?.kind,
      pendingKind: activeFolderPendingKind,
      folder: activeFolder,
    }) === "design";

  const visibleWorkspaces = useMemo(
    () =>
      selectedProject
        ? withLocalMainWorkspace(selectedProject, accessibleWorkspaces)
        : [],
    [accessibleWorkspaces, selectedProject],
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
  const rawPendingCreates = usePendingCreatesAll();
  const allPendingCreates = useMemo(
    () =>
      filterRowsForOrganization(
        filterPendingCreatesForDesignAccess(
          rawPendingCreates,
          designWorkspacesActive,
        ),
        activeOrganization,
      ),
    [activeOrganization, designWorkspacesActive, rawPendingCreates],
  );
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

  // Optimistic creates share the live strip immediately. Keep the deduped
  // collection stable so layout observation, pinning, and rendering all see
  // the exact same tab identities during the pending → confirmed handoff.
  const rawProjectPendingCreates = usePendingCreatesFor(
    selectedProject?.repoSlug ?? null,
  );
  const pendingCreates = useMemo(
    () =>
      filterRowsForOrganization(
        filterPendingCreatesForDesignAccess(
          rawProjectPendingCreates,
          designWorkspacesActive,
        ),
        activeOrganization,
      ),
    [activeOrganization, designWorkspacesActive, rawProjectPendingCreates],
  );
  const dedupedPendingCreates = useMemo(
    () => dedupePendingCreates(pendingCreates, realWorkspaces),
    [pendingCreates, realWorkspaces],
  );

  // A cold repository switch is allowed to publish its remembered folder
  // before the workspace list settles. Only a completed exact-key snapshot may
  // invalidate that identity; when it proves the worktree was deleted, move to
  // main as a new authoritative navigation (never as an initial-cache guess).
  useEffect(() => {
    // MainShellBody owns internal-access recovery for this route. Never turn a
    // hidden design destination into a coding destination here: doing so could
    // auto-spawn an unrelated coding chat while staff identity is still loading.
    if (activeFolderBlockedDesign) return;
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
      findWorkspaceForFolder(activeFolder, accessibleWorkspaces)
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
    if (activeFolderProvisioning && !activeFolderBlockedDesign) return;
    // A slow create (past the ~60s settling cap) whose real row hasn't landed
    // yet must not be bounced to main — its placeholder create is still in
    // flight, so the announced path is legitimate even though it isn't listed.
    if (allPendingCreates.some((c) => c.path === activeFolder)) return;
    openWorkspace(
      resolveRepoWorkspaceDestination({
        project: selectedProject,
        rememberedFolder: activeFolder,
        cachedWorkspaces: accessibleWorkspaces,
        allowLocalMain: workInLocalMain,
        allowDesignWorkspaces: designWorkspacesActive,
      }),
    );
  }, [
    activeFolder,
    activeFolderBlockedDesign,
    activeFolderProvisioning,
    activePage,
    activeProject?.id,
    accessibleWorkspaces,
    allPendingCreates,
    designWorkspacesActive,
    dispatch,
    loading,
    mainWorkspace,
    openWorkspace,
    refreshing,
    selectedProject,
    workInLocalMain,
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

  const workspaceNavRef = useRef<HTMLElement | null>(null);
  const workspaceTabRefs = useRef(new Map<string, HTMLDivElement>());
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

    const activeId = activeWorkspaceTabKey;
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
  }, [activeWorkspaceTabKey, mainWorkspace?.id]);

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
    () =>
      [
        ...realWorkspaces.map((workspace) => `workspace:${workspace.id}`),
        ...dedupedPendingCreates.map((pending) => `pending:${pending.token}`),
      ].join(","),
    [dedupedPendingCreates, realWorkspaces],
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
  }, [loading, workspaceTabIdentity, syncWorkspaceStrip]);

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
    });
    if (Math.abs(nav.scrollLeft - targetScrollLeft) > 0.5) {
      nav.scrollLeft = targetScrollLeft;
    }
    syncWorkspaceStrip();
  }, [
    activeWorkspaceTabKey,
    mainWorkspace?.id,
    workspaceTabIdentity,
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
          allowDesignWorkspaces: designWorkspacesActive,
        }),
      );
    },
    [
      activePage,
      activeProject?.id,
      activeRepoId,
      designWorkspacesActive,
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
      if (workspace.kind === "design" && !designWorkspacesActive) return;
      prefetchWorkspaceSurface(workspace);
      if (workspace.kind === "design") return;
      const chatId = selectChatToRestoreForFolder(
        useWorkspaceStore.getState(),
        workspace.path,
      );
      if (chatId) {
        void sessions.hydrateChat(chatId);
        prepareChatView(chatId);
      }
    },
    [designWorkspacesActive, sessions],
  );

  /** Create directly in the selected repository, then move into the new
   * workspace. The global plus remains the richer Dispatcher entry point.
   * The optimistic flow itself lives in ./create-workspace, shared with the
   * repo-add paths that now open a workspace instead of the trunk. */
  const handleCreateWorkspace = useCallback(
    async (kind: "code" | "design") => {
      if (!selectedProject) return;
      if (kind === "design" && !designWorkspacesActive) return;
      await createWorkspaceForProject({
        project: selectedProject,
        dispatch,
        kind,
      });
    },
    [designWorkspacesActive, dispatch, selectedProject],
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
  const mainTabVisible = workInLocalMain && !!mainWorkspace;
  const mainActive = mainTabVisible && activeWorkspaceId === mainWorkspace.id;
  const stripHasTabs =
    realWorkspaces.length > 0 || dedupedPendingCreates.length > 0;
  const hasProjectContext = !!selectedProject || !!pendingOnly;

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
      <div className={TOP_BAR_LEADING_ITEM_CLS}>
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
      </div>

      {hasProjectContext && (
        <TopBarBoundary
          showSeparator={navigationBoundarySeparatorVisible(homeActive, false)}
        />
      )}

      {selectedProject ? (
        <div className={TOP_BAR_ITEM_CLS}>
          <ProjectPicker
            selectedProject={selectedProject}
            projects={projects}
            openingRoot={openingRoot}
            onSelect={handleSelectProject}
            onCreate={() => openDispatcher(selectedProject.id)}
            designWorkspacesActive={designWorkspacesActive}
          />
        </div>
      ) : pendingOnly ? (
        <div
          className="text-fg2 flex h-7 min-w-0 shrink-0 items-center gap-2 rounded-md px-2.5 text-xs"
          role="status"
          aria-live="polite"
        >
          <ZerosSpinner size={14} label={`Opening ${pendingOnly.name}`} />
          <span className="max-w-48 truncate">{pendingOnly.name}</span>
        </div>
      ) : null}

      {/* Main remains fixed before the workspace tabs. The tab
          strip sizes to its contents while there is room, keeping the plus
          directly after the final tab. Once the row fills, only the workspace
          nav shrinks and scrolls; the plus remains fixed. */}
      <div className="flex h-full min-w-0 flex-1 items-stretch">
        {workInLocalMain && mainWorkspace && (
          <>
            {hasProjectContext && (
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
          </>
        )}

        {stripHasTabs && (
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
              {/* Boundary carriers own the four-pixel spacing. gap-0 prevents
                  flex spacing from double-counting them; px-0 keeps the first
                  carrier itself as the exact sticky/content inset. */}
              <div className="relative flex h-full w-max items-center gap-0 px-0">
                {realWorkspaces.map((workspace, index) => {
                  const active = activeWorkspaceTabKey === workspace.id;
                  const leftActive =
                    index === 0
                      ? mainActive
                      : activeWorkspaceTabKey === realWorkspaces[index - 1]?.id;
                  return (
                    <React.Fragment key={workspace.id}>
                      <TopBarBoundary
                        edge={index === 0}
                        showSeparator={navigationBoundarySeparatorVisible(
                          leftActive,
                          active,
                        )}
                      />
                      <WorkspaceTab
                        workspace={workspace}
                        active={active}
                        chatIds={chatIdsByWorkspace.get(workspace.id) ?? []}
                        onSelect={handleSelectWorkspace}
                        onPrefetch={handlePrefetchWorkspace}
                        onArchive={(target) => void archiveWorkspace(target)}
                        tabRef={(node) =>
                          registerWorkspaceTab(workspace.id, node)
                        }
                      />
                    </React.Fragment>
                  );
                })}
                {/* Optimistic creates: one placeholder tab per in-flight
                    workspace.create so the click has a visible result THIS
                    frame; replaced by the real tab when the RPC lands (the
                    branch filter hides the placeholder the moment the real row
                    reaches the list, so the tab never doubles). Active when the
                    user was navigated to its announced path. */}
                {dedupedPendingCreates.map((pending, index) => {
                  const active = activeWorkspaceTabKey === pending.token;
                  const previousPending = dedupedPendingCreates[index - 1];
                  const previousReal = realWorkspaces.at(-1);
                  const leftActive = previousPending
                    ? activeWorkspaceTabKey === previousPending.token
                    : previousReal
                      ? activeWorkspaceTabKey === previousReal.id
                      : mainActive;
                  return (
                    <React.Fragment key={pending.token}>
                      <TopBarBoundary
                        edge={realWorkspaces.length === 0 && index === 0}
                        showSeparator={navigationBoundarySeparatorVisible(
                          leftActive,
                          active,
                        )}
                      />
                      <PendingWorkspaceTab
                        kind={pending.kind}
                        label={
                          pending.branch
                            ? branchDisplayName(pending.branch)
                            : "New workspace"
                        }
                        active={active}
                        tabRef={(node) =>
                          registerWorkspaceTab(pending.token, node)
                        }
                      />
                    </React.Fragment>
                  );
                })}
                {/* The trailing carrier is the workspace → plus gap. Actions
                    get spacing but no navigation separator. */}
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

        {selectedProject && !stripHasTabs && (
          <TopBarBoundary showSeparator={false} />
        )}

        {selectedProject && (
          <div className={TOP_BAR_ITEM_CLS}>
            {/* Keep the shipped code-workspace action one click when Design is
                unavailable. Internal staff who enable Design get the kind
                picker; both paths retain the same plain plus affordance. */}
            {designWorkspacesActive ? (
              <DropdownMenu>
                <Tooltip label="New workspace" side="bottom">
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={INSET_ICON_BUTTON_CLS}
                      aria-label="New workspace"
                    >
                      <Plus className="size-4" strokeWidth={1.5} />
                    </Button>
                  </DropdownMenuTrigger>
                </Tooltip>
                <DropdownMenuContent
                  align="start"
                  sideOffset={6}
                  className="w-48"
                >
                  <DropdownMenuItem
                    onSelect={() => void handleCreateWorkspace("code")}
                  >
                    <GitBranch className="text-fg2" />
                    <span>Code workspace</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => void handleCreateWorkspace("design")}
                  >
                    <PenTool className="text-fg2" />
                    <span>Design workspace</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Tooltip label="New workspace" side="bottom">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={INSET_ICON_BUTTON_CLS}
                  aria-label="New workspace"
                  onClick={() => void handleCreateWorkspace("code")}
                >
                  <Plus className="size-4" strokeWidth={1.5} />
                </Button>
              </Tooltip>
            )}
          </div>
        )}

        {selectedProject && <TopBarBoundary showSeparator={false} />}

        <div className="min-w-0 flex-1" aria-hidden="true" />
      </div>

      {/* gap-1 remains correct when ResourceMonitor is unavailable and returns
          null: React leaves only Archive in this flex row, so no phantom
          second gap appears during native-runtime startup. */}
      <div className="flex h-full shrink-0 items-center gap-1">
        <ResourceMonitor />

        <div className={TOP_BAR_TRAILING_ITEM_CLS}>
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
      </div>
    </header>
  );
}
