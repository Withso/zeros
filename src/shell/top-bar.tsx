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

import {
  isGitErrorShape,
  isWorkspaceOpStillRunning,
  workspaceCreate,
  workspacePrepareCreate,
  type Workspace,
} from "../native/git";
import { usePrIslandKind } from "./pr/pr-island-state-store";
import { getSetting, setSetting } from "../native/settings";
import { useNativeRuntime } from "../native/runtime";
import { trackWorkspaceOpened } from "../zeros/analytics/agent-events";
import { useAgentSessions } from "../zeros/agent/sessions-hooks";
import { dbDeleteChat } from "../zeros/agent/agent-history-client";
import {
  useAnyChatAwaitingKind,
  useAnyChatStreaming,
} from "../zeros/agent/sessions-store";
import {
  isLocalMainWorkspace,
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
import { spawnPreparedDefaultChat } from "../zeros/store/spawn-default-chat";
import {
  notifyProjectsChanged,
  notifyWorkspacesChanged,
  peekWorkspacesFor,
  prefetchWorkspacesFor,
  reloadWorkspacesFor,
  watchTimedOutWorkspaceCreate,
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
import { toast } from "../zeros/ui/primitives/elements";
import { Tooltip } from "../zeros/ui/primitives/tooltip";
import { RepositoryIcon } from "../zeros/ui/repository-icon";
import { WorkspaceContextMenu } from "../zeros/ui/workspace-context-menu";
import { formatCompactAge } from "../zeros/agent/format-age";
import { ZerosSpinner } from "../loaders";
import { useAddProject } from "./add-project-provider";
import {
  beginPendingCreate,
  clearWorkspaceSettling,
  finishPendingCreate,
  markWorkspaceSettling,
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
} from "./top-bar-helpers";
import { useCustomWindowDrag } from "./use-custom-window-drag";

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
    }),
  );
}

const ICON_BUTTON_CLS =
  "shrink-0 text-fg2 hover:bg-sidebar-bg-hover hover:text-fg1 data-[active=true]:bg-sidebar-bg-hover data-[active=true]:text-fg1";
// The app window bottoms out at 800px. Interpolate through the constrained
// 800–1200px band, then hold the requested default/max widths above it.
const PROJECT_TRIGGER_CLS =
  "w-[clamp(100px,calc(10vw_+_20px),140px)] min-w-[100px] max-w-[140px] shrink-0 justify-start gap-2 border-0 bg-transparent px-2 text-xs text-fg2 shadow-none hover:bg-sidebar-bg-hover hover:text-fg1 data-[state=open]:bg-sidebar-bg-hover data-[state=open]:text-fg1";
const PROJECT_CHIP_CLS =
  "inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-bg2-hover text-xxs font-medium text-fg2";
const WORKSPACE_TAB_CLS =
  "group/workspace relative flex h-7 w-[clamp(120px,calc(10vw_+_40px),160px)] min-w-[120px] max-w-[160px] shrink-0 select-none items-center overflow-hidden rounded-sm px-2 text-left text-xs text-fg2 transition-none focus-within:bg-sidebar-bg-hover focus-within:text-fg2 data-[hovered=true]:bg-sidebar-bg-hover data-[hovered=true]:text-fg2 data-[active=true]:sticky data-[active=true]:left-1 data-[active=true]:right-1 data-[active=true]:z-20 data-[active=true]:bg-sidebar-bg-hover data-[active=true]:text-fg1 data-[active=true]:focus-within:text-fg1 data-[active=true]:data-[hovered=true]:text-fg1";
const WORKSPACE_OPEN_BUTTON_CLS =
  "h-full min-w-0 flex-1 justify-start gap-2 border-0 bg-transparent p-0 text-left text-xs text-inherit shadow-none transition-none hover:bg-transparent hover:text-inherit [&_svg]:size-3.5";
const WORKSPACE_ACTION_OVERLAY_CLS =
  "pointer-events-none absolute inset-y-0 right-0 flex w-10 items-center justify-end bg-gradient-to-l from-sidebar-bg-hover from-50% to-transparent pr-1 opacity-0 transition-none group-data-[hovered=true]/workspace:opacity-100 focus-within:opacity-100";
const WORKSPACE_ACTION_CLS =
  "pointer-events-auto inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-fg2 transition-[background-color,color] duration-120 ease-out hover:bg-bg2-hover hover:text-fg1";
// Normal-flow and sticky tabs retain the requested 4px edge spacing. Fixed,
// opaque gutters cover those four pixels so scrolling labels never leak into
// the visual gap beside the main/plus controls.
const WORKSPACE_CONTENT_INSET_PX = 4;
const WORKSPACE_STICKY_EDGE_INSET_PX = 4;
const WORKSPACE_TAB_GAP_PX = 4;
const WORKSPACE_FADE_WIDTH_PX = 24;

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
        aria-label={`Open workspace ${label}`}
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
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
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
      <span className="ml-2 min-w-0 flex-1 truncate text-left">{label}</span>
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
            className={ICON_BUTTON_CLS}
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

  // Recalculate masks when the window or tab content changes. Observing both
  // boxes covers responsive widths, async workspace loads, and icon changes.
  // The active tab itself is always CSS-sticky, so it never waits for this JS.
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
    if (nav.firstElementChild) observer?.observe(nav.firstElementChild);
    window.addEventListener("resize", syncWorkspaceStrip);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", syncWorkspaceStrip);
    };
  }, [loading, realWorkspaces.length, syncWorkspaceStrip]);

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
   * Optimistic: prepareCreate reserves identity + final path (milliseconds),
   * the strip gets a "Setting up workspace…" tab and the app NAVIGATES to the
   * announced path with a provisional Untitled chat in the same beat; the heavy
   * create then runs in the background and enables its queued session once the
   * authoritative workspace row lands. */
  const handleCreateWorkspace = useCallback(async () => {
    const project = selectedProject;
    // Every click is an independent exact reservation. Do not serialize even
    // the cheap prepare phase: users intentionally fan out several workspaces
    // while prior creates and archives continue in parallel.
    if (!project) return;
    let prepared: Awaited<ReturnType<typeof workspacePrepareCreate>>;
    try {
      prepared = await workspacePrepareCreate({
        repoRoot: project.repoRoot,
        repoSlug: project.repoSlug,
      });
    } catch (error: unknown) {
      if (isGitErrorShape(error)) {
        toast.error(`Couldn't create workspace: ${error.message}`, {
          description: error.remediation ?? error.causeMessage ?? undefined,
        });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(`Couldn't create workspace: ${message}`);
      }
      return;
    }
    const pendingToken = beginPendingCreate({
      repoRoot: project.repoRoot,
      repoSlug: project.repoSlug,
      path: prepared.path,
      branch: prepared.branch,
    });
    // Column 3 shows its "Setting up workspace" loading rows from the first
    // frame; the flag clears once the row lands and its surface data is in.
    // Marked BEFORE navigation so the workspace-list validation effect below
    // knows not to bounce the not-yet-listed folder back to main.
    markWorkspaceSettling(prepared.path);
    // Publish the exact folder destination AND its first Untitled chat in one
    // transition. The composer is usable now; its session remains gated on the
    // create lifecycle and any early Send is queued by exact chat id.
    const chat = spawnPreparedDefaultChat({
      folder: prepared.path,
      repoRoot: project.repoRoot,
      dispatch,
    });
    const rollbackOptimisticChat = () => {
      clearWorkspaceSettling(prepared.path);
      dispatch({ type: "CONSUME_AUTO_SEND", chatId: chat.id });
      dispatch({ type: "DELETE_CHAT", id: chat.id });
      void dbDeleteChat(chat.id).catch(() => {});
      finishPendingCreate(pendingToken);
    };
    const settleArchivedOptimisticChat = () => {
      // Archive keeps this chat/draft for a later restore; only its queued
      // first turn is no longer runnable because the worktree was removed.
      clearWorkspaceSettling(prepared.path);
      dispatch({ type: "CONSUME_AUTO_SEND", chatId: chat.id });
      finishPendingCreate(pendingToken);
    };
    try {
      const created = await workspaceCreate({
        repoRoot: project.repoRoot,
        repoSlug: project.repoSlug,
        ...(chat.agentId ? { agentId: chat.agentId } : {}),
        preparedId: prepared.workspaceId,
        preparedBranch: prepared.branch,
        optimisticChatId: chat.id,
      });
      trackWorkspaceOpened({ isWorktree: true, status: created.status });
      notifyWorkspacesChanged(project.repoSlug);
      // Await an authoritative refresh so the real row is committed to the
      // single source BEFORE the pending placeholder drops — otherwise the
      // strip briefly shows NO tab for the workspace the user is sitting in.
      // If ingestion is momentarily disconnected, retain the placeholder and
      // follow the exact lifecycle/row until the complete key can be committed.
      if (
        (await reloadWorkspacesFor(project.repoSlug)) &&
        peekWorkspacesFor(project.repoSlug)?.some(
          (workspace) => workspace.id === prepared.workspaceId,
        )
      ) {
        finishPendingCreate(pendingToken);
      } else {
        watchTimedOutWorkspaceCreate({
          repoSlug: project.repoSlug,
          workspaceId: prepared.workspaceId,
          onReady: () => finishPendingCreate(pendingToken),
          onUnavailable: (reason) => {
            if (reason === "archived") {
              settleArchivedOptimisticChat();
              return;
            }
            rollbackOptimisticChat();
            toast.error("Workspace became unavailable after creation", {
              description:
                reason === "interrupted"
                  ? "Creation stopped in a recoverable phase. Restart Zeros to finish recovery."
                  : "The workspace was removed before its list row could be loaded.",
            });
          },
        });
      }
    } catch (error: unknown) {
      if (isWorkspaceOpStillRunning(error)) {
        // The engine keeps working past the client budget — retain the announced
        // destination + settling state until exact lifecycle observation settles it.
        toast.info("Workspace creation is taking longer than usual", {
          description: "It's still being created in the background.",
        });
        watchTimedOutWorkspaceCreate({
          repoSlug: project.repoSlug,
          workspaceId: prepared.workspaceId,
          onReady: (workspace) => {
            trackWorkspaceOpened({
              isWorktree: true,
              status: workspace.status,
            });
            finishPendingCreate(pendingToken);
          },
          onUnavailable: (reason) => {
            if (reason === "archived") {
              settleArchivedOptimisticChat();
              return;
            }
            rollbackOptimisticChat();
            toast.error("Couldn't finish creating workspace", {
              description:
                reason === "interrupted"
                  ? "Creation stopped in a recoverable phase. Restart Zeros to finish recovery, then try again."
                  : "The engine rolled the incomplete checkout back safely. Create it again to retry.",
            });
          },
        });
      } else {
        // Hard failure: roll back only this exact provisional chat/path. The
        // validation effect sees the absent row and chooses a valid destination.
        rollbackOptimisticChat();
        notifyWorkspacesChanged(project.repoSlug);
        if (isGitErrorShape(error)) {
          toast.error(`Couldn't create workspace: ${error.message}`, {
            description: error.remediation ?? error.causeMessage ?? undefined,
          });
        } else {
          const message =
            error instanceof Error ? error.message : String(error);
          toast.error(`Couldn't create workspace: ${message}`);
        }
      }
    }
  }, [dispatch, selectedProject]);

  // Pending creates for the visible repository — one "Setting up workspace…"
  // tab each, from ANY create surface (this plus or the Dispatcher).
  const pendingCreates = usePendingCreatesFor(
    selectedProject?.repoSlug ?? null,
  );
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
      <div className="border-border1 flex h-full shrink-0 items-center border-r px-1">
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
        {mainWorkspace && (
          <div className="border-border1 flex h-full shrink-0 items-center border-r px-1">
            <Tooltip label="main" side="bottom">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={ICON_BUTTON_CLS}
                aria-current={
                  activeWorkspaceId === mainWorkspace.id ? "page" : undefined
                }
                aria-label="Open main checkout"
                data-active={activeWorkspaceId === mainWorkspace.id}
                onPointerEnter={() => handlePrefetchWorkspace(mainWorkspace)}
                onFocus={() => handlePrefetchWorkspace(mainWorkspace)}
                onClick={() => handleSelectWorkspace(mainWorkspace)}
              >
                <LaptopMinimal className="size-4" strokeWidth={1.25} />
              </Button>
            </Tooltip>
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
            <div className="relative flex h-full w-max items-center gap-1 px-1">
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
              outer fade relocates immediately after/before the tab. The solid
              four-pixel gutters sit above all scrolling content, preserving
              edge spacing without allowing labels to show through it. */}
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

        {selectedProject && (
          <div className="flex h-full shrink-0 items-center px-1">
            {/* Always the plain plus — never a spinner/disabled swap. Every
                click reserves an independent workspace, while the optimistic
                tab + navigation provide immediate per-click feedback. */}
            <Tooltip label="New workspace" side="bottom">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={ICON_BUTTON_CLS}
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

      <div className="border-border1 flex h-full shrink-0 items-center border-l px-1">
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
              className={ICON_BUTTON_CLS}
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
