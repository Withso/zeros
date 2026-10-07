import { useOrganizationProjects } from "../state/use-organization-projects";
// ============================================
// COMPONENT: AppSidebar
// PURPOSE: The app's single left navigation — window chrome, organization,
//          Home destinations, Create, and every workspace, grouped by
//          repository (default) or as one mixed list.
// USED IN: MainShellBody (app-shell.tsx) on every page. Settings takes the
//          sidebar's place with its own section nav, so the sidebar stays
//          mounted but hidden and inert there.
// ============================================
//
//   ┌──────────────────────────────┐
//   │ ● ● ● [▯]        [cpu][←][→] │  40px title band (window drag)
//   │ ▭ Local ⌄                     │  organization switcher
//   │ Home · Customize · Create     │  destinations (Create is an action)
//   │ ───────────────────────────── │
//   │ Workspaces                [⋯] │  Grouped / Ungrouped
//   │ [W] Zeros          [⚙][⋯] [+] │  repository header (Grouped)
//   │     ⎇ atlanta          +12 ✎  │  workspace rows
//   │ ───────────────────────────── │
//   │ (A) you@example.com       [⚙] │  profile + Settings
//   └──────────────────────────────┘
//
// It also owns the navigation keepers the former top bar owned: project sync,
// settings prefetch, run-activity sync, idle file warming, and validation of a
// remembered workspace once its exact repository list settles.

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Blocks,
  Check,
  Ellipsis,
  Folder,
  House,
  Plus,
  Settings,
} from "lucide-react";

import { type Workspace } from "../platform/git";
import { trackWorkspaceOpened } from "../platform/observability/analytics/agent-events";
import { useNativeRuntime } from "../platform/runtime";
import { useAuth } from "../features/auth";
import { useAgentSessions } from "../features/agent/sessions-hooks";
import {
  prefetchSettingsForRepo,
  usePrefetchSettings,
} from "../features/settings/use-settings";
import { filterRowsForOrganization } from "../features/team/organization-capabilities";
import { OrganizationSwitcher } from "../features/team/organization-switcher";
import { useActiveOrganization } from "../features/team/team-store";
import { useArchiveWorkspace } from "../state/archive-actions";
import { draftChatIdsByWorkspace } from "../state/composer-draft-presence";
import {
  dedupePendingCreates,
  useLiveVisible,
} from "../state/live-workspace-selectors";
import { isLocalMainWorkspace } from "../state/local-main-workspace";
import {
  usePendingCreatesAll,
  useWorkspaceProvisioning,
} from "../state/pending-workspaces";
import {
  pruneWorktreePhantomProjects,
  type Project,
} from "../state/projects-store";
import {
  selectActiveFolder,
  selectChatToRestoreForFolder,
  useActivePage,
  useActiveRepoId,
  useChats,
  useCreateWorkspaceProjectId,
  useWorkspaceDispatch,
  useWorkspaceListFilter,
  useWorkspaceStore,
} from "../state/store";
import { useFolderWorkspaces } from "../state/use-folder-workspaces";
import { useActiveWorkspace } from "../state/use-active-workspace";
import { useOpenWorkspace } from "../state/use-open-workspace";
import {
  notifyProjectsChanged,
  peekWorkspacesFor,
  useLiveWorkspaces,
  useSyncProjectsToEngine,
  useWorkspacesFor,
} from "../state/use-projects";
import { workspaceIsReadOnly } from "../state/workspace-history";
import {
  findProjectForFolder,
  findWorkspaceForFolder,
} from "../state/workspace-resolution";
import { cn } from "../shared/ui/cn";
import { ZerosSpinner } from "../shared/ui/loading";
import { Button } from "../shared/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../shared/ui/primitives/dropdown-menu";
import { toast } from "../shared/ui/primitives/elements";
import { Tooltip } from "../shared/ui/primitives/tooltip";
import { branchDisplayName } from "../shared/lib/branch-name";
import { useAddProject } from "./add-project-provider";
import { prepareChatView } from "./conversation/chat-intent";
import {
  HOME_SIDEBAR_DEFAULT_PX,
  setHomeSidebarWidth,
  useHomeSidebarWidth,
} from "./home-sidebar-width";
import {
  prefetchWorkspaceSurface,
  type WorkspaceNavigationTarget,
} from "./prefetch-workspace-surface";
import { ResourceMonitor } from "./resource-monitor";
import {
  setRepositoryCollapsed,
  useCollapsedRepositories,
} from "./sidebar-collapsed-repositories";
import { SidebarHistoryButtons } from "./sidebar-history-buttons";
import type { SidebarHistoryScope } from "./sidebar-navigation-history";
import {
  SIDEBAR_ROW_ACTION_CLS,
  SidebarRepositoryHeader,
} from "./sidebar-repository-header";
import {
  buildSidebarWorkspaceEntries,
  SIDEBAR_WORKSPACE_LIST_FILTERS,
  sidebarItemSelectionKey,
  sidebarScrollTopToReveal,
  sidebarWorkspaceItems,
  sidebarWorkspaceListFilter,
  visibleRepositoryItems,
  type SidebarWorkspaceItem,
} from "./sidebar-workspace-model";
import {
  PendingSidebarWorkspaceRow,
  SidebarWorkspaceRow,
} from "./sidebar-workspace-row";
import {
  APP_SIDEBAR_ID,
  SidebarToggleButton,
  TRAFFIC_LIGHT_RESERVE_CLS,
} from "./sidebar-toggle";
import { useWorkspaceRunActivitySync } from "./terminal/run-activity-store";
import { useCustomWindowDrag } from "./use-custom-window-drag";
import { useHomeSidebarResizeDrag } from "./use-home-sidebar-drag";
import { useResizeHint } from "./use-resize-hint";
import { warmWorkspaceFiles } from "./workspace-files-cache";
import { resolveRepoWorkspaceDestination } from "./workspace-tabs";
import { Surface } from "@/renderer/shared/ui/layout/surface";

// --- CONSTANTS ---

// One shared destination-row shape, mirroring the Settings rail's entry
// (settings-page.tsx SIDEBAR_ENTRY_CLS) so both navigations read as the same
// control: fg2 at rest, fg1 on the lifted --sidebar-bg-hover when selected.
// Every sidebar row — destinations, repositories and workspaces — is 30px.
// Selection is colour-only; rows never shift width. Icons are 14px via the
// primitive's own `[&_svg]:` selector so twMerge drops its default size.
const SIDEBAR_ENTRY_CLS =
  "flex h-7.5 w-full min-w-0 items-center justify-start gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-0 text-left text-xs font-normal text-fg2 transition-colors duration-150 ease-out hover:bg-(--surface-hover) hover:text-fg2 data-[state=active]:bg-(--surface-hover) data-[state=active]:text-fg1 data-[state=active]:hover:text-fg1 [&_svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-fg2 data-[state=active]:[&>svg]:text-fg1";
// The list's section label: 12px on the default fg2 tier.
const SECTION_LABEL_CLS = "select-none truncate text-3xxs text-fg2";
// The sidebar never squeezes the workspace below its column floors
// (conversation 360px + workbench 200px + seams); the persisted width is a
// preference, this cap is the live window's constraint.
const SIDEBAR_MAX_WIDTH_CLS = "max-w-[calc(100vw-580px)]";

const EMPTY_WORKSPACE_CHAT_IDS: readonly string[] = Object.freeze([]);

// --- HELPERS ---

/** The project registry stopped backfilling arbitrary chat folders long ago,
 * but this one-shot cleanup still removes phantom worktree rows left by older
 * builds. The navigation owns it because it is mounted for the app's life. */
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

/** Keep the native-runtime failure explanation mounted with the navigation. A
 * missing preload is actionable during development; a real browser session is
 * informational because reload cannot create Electron IPC. */
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

/** Initials for the profile avatar — first letters of the first two words
 *  of the display name (falls back to the email's first letter). */
function profileInitials(name: string | null, email: string | null): string {
  const source = (name ?? "").trim() || (email ?? "").trim();
  if (!source) return "·";
  const words = source.split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? "";
  const second = words.length > 1 ? (words[1][0] ?? "") : "";
  return (first + second).toUpperCase() || "·";
}

// --- ROOT COMPONENT ---

export function AppSidebar({ hidden = false }: { hidden?: boolean }) {
  const activeResolution = useActiveWorkspace();
  const chats = useChats();
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
  const { projects } = useOrganizationProjects();
  const projectRepoRoots = useMemo(
    () => projects.map((project) => project.repoRoot),
    [projects],
  );
  const { openDispatcher, pendingProject, openingRoot } = useAddProject();
  const openWorkspace = useOpenWorkspace();
  const archiveWorkspace = useArchiveWorkspace();
  const { session, email } = useAuth();

  usePruneLegacyPhantomProjects();
  useSyncProjectsToEngine();
  usePrefetchSettings(projectRepoRoots);
  useNativeRuntimeNotice();

  const activeProject = useMemo(
    () => findProjectForFolder(activeFolder, projects),
    [activeFolder, projects],
  );

  // The title band is the window's drag handle; its interactive descendants
  // are excluded automatically by useCustomWindowDrag.
  const titleBandRef = useRef<HTMLDivElement | null>(null);
  useCustomWindowDrag(titleBandRef);

  // Older builds persisted Active and repository-only presentations. Paint the
  // folded value immediately and persist it once, so the stored filter always
  // names one of the two presentations this navigation offers.
  const requestedFilter = useWorkspaceListFilter();
  const listFilter = sidebarWorkspaceListFilter(requestedFilter);
  useEffect(() => {
    if (listFilter !== requestedFilter) {
      dispatch({ type: "SET_WORKSPACE_LIST_FILTER", filter: listFilter });
    }
  }, [dispatch, listFilter, requestedFilter]);
  const groupedList = listFilter === "grouped";

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
    routedRepoProject ??
    routedCreateProject ??
    activeProject ??
    projects[0] ??
    null;

  // The list projects one shared exact-key union. Keep a separate subscription
  // to the active owner for route validation: only that settled key may reject
  // a remembered destination.
  const { workspaces: liveWorkspaces, loading: liveLoading } =
    useLiveWorkspaces();
  const {
    workspaces: activeProjectWorkspaces,
    loading: activeProjectLoading,
    refreshing: activeProjectRefreshing,
  } = useWorkspacesFor(activeProject?.repoSlug ?? null);

  const listedWorkspaces = useFolderWorkspaces(liveWorkspaces, projects);
  const accessibleWorkspaces = useMemo(
    () => filterRowsForOrganization(listedWorkspaces, activeOrganization),
    [activeOrganization, listedWorkspaces],
  );
  const activeProjectAccessibleWorkspaces = useMemo(
    () =>
      filterRowsForOrganization(activeProjectWorkspaces, activeOrganization),
    [activeOrganization, activeProjectWorkspaces],
  );

  const mainWorkspace =
    activeResolution.workspace &&
    isLocalMainWorkspace(activeResolution.workspace)
      ? activeResolution.workspace
      : null;
  const realWorkspaces = useLiveVisible(accessibleWorkspaces);
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
  // In-flight creates across all repos — used both to render pending rows and
  // to protect a slow-create's announced path from the bounce-to-main effect.
  const rawPendingCreates = usePendingCreatesAll();
  const allPendingCreates = useMemo(
    () => filterRowsForOrganization(rawPendingCreates, activeOrganization),
    [activeOrganization, rawPendingCreates],
  );
  const dedupedPendingCreates = useMemo(
    () => dedupePendingCreates(allPendingCreates, accessibleWorkspaces),
    [allPendingCreates, accessibleWorkspaces],
  );
  // Back/forward reopen only what this sidebar lists right now.
  const historyScope = useMemo<SidebarHistoryScope>(
    () => ({
      projects,
      workspaces: realWorkspaces,
      pendingCreates: dedupedPendingCreates,
    }),
    [dedupedPendingCreates, projects, realWorkspaces],
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
  const draftIdsByWorkspace = useMemo(
    () => draftChatIdsByWorkspace(chats, realWorkspaces),
    [chats, realWorkspaces],
  );

  const entries = useMemo(
    () =>
      buildSidebarWorkspaceEntries({
        filter: listFilter,
        projects,
        workspaces: realWorkspaces,
        pending: dedupedPendingCreates,
      }),
    [dedupedPendingCreates, listFilter, projects, realWorkspaces],
  );
  const listedItems = useMemo(() => sidebarWorkspaceItems(entries), [entries]);

  // A cold repository switch is allowed to publish its remembered folder
  // before the workspace list settles. Only a completed exact-key snapshot may
  // invalidate that identity; when it proves the worktree was deleted, open
  // another worktree or its repository page (never an initial-cache guess).
  useEffect(() => {
    if (
      activePage !== "workspace" ||
      !activeFolder ||
      !activeProject ||
      activeProjectLoading ||
      activeProjectRefreshing ||
      activeResolution.loading ||
      peekWorkspacesFor(activeProject.repoSlug) === undefined
    ) {
      return;
    }
    if (
      workspaceIsReadOnly(activeResolution.workspace) ||
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
    const destination = resolveRepoWorkspaceDestination({
      project: activeProject,
      rememberedFolder: activeFolder,
      cachedWorkspaces: activeProjectAccessibleWorkspaces,
    });
    if (destination) openWorkspace(destination);
    else
      dispatch({
        type: "OPEN_REPO_PAGE",
        projectId: activeProject.id,
        view: "workspaces",
      });
  }, [
    activeFolder,
    activeFolderProvisioning,
    activeResolution.loading,
    activeResolution.workspace,
    activePage,
    activeProject,
    activeProjectAccessibleWorkspaces,
    allPendingCreates,
    dispatch,
    activeProjectLoading,
    activeProjectRefreshing,
    mainWorkspace,
    openWorkspace,
  ]);

  const activeWorkspaceId = useMemo(() => {
    if (activePage !== "workspace" || !activeFolder) return null;
    const visible = listedItems.flatMap((item) =>
      item.kind === "workspace" ? [item.workspace] : [],
    );
    const engineWorkspace = findWorkspaceForFolder(activeFolder, visible);
    if (engineWorkspace) return engineWorkspace.id;
    // Reuse the normalized folder resolver for `/private/var` ↔ `/var` and
    // chats rooted in a subdirectory of main. A raw prefix check would leave
    // the main row inactive for those otherwise-valid paths.
    const insideMainCheckout = mainWorkspace
      ? !!findWorkspaceForFolder(activeFolder, [mainWorkspace])
      : false;
    return mainWorkspace && insideMainCheckout ? mainWorkspace.id : null;
  }, [activeFolder, activePage, listedItems, mainWorkspace]);
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
  // row is revealable for the entire transition.
  const activeSelectionKey =
    activeWorkspaceId ?? activePendingCreate?.token ?? null;

  const collapsedRepositories = useCollapsedRepositories();

  // Dashboard cards, deep links and new creates can select a workspace the
  // sidebar did not click. Reveal its row before paint — scrolling only the
  // list, never an overflow-hidden ancestor as scrollIntoView would. Each
  // selection (per presentation) is revealed ONCE, retrying until its row
  // exists; unrelated rows arriving later never pull a list the user scrolled
  // back to the selection.
  const listRef = useRef<HTMLDivElement | null>(null);
  const revealedSelectionRef = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const registerRow = useCallback(
    (key: string, node: HTMLDivElement | null) => {
      if (node) rowRefs.current.set(key, node);
      else rowRefs.current.delete(key);
    },
    [],
  );
  const listIdentity = useMemo(
    () => listedItems.map((item) => item.key).join(","),
    [listedItems],
  );
  useLayoutEffect(() => {
    if (!activeSelectionKey) {
      revealedSelectionRef.current = null;
      return;
    }
    if (hidden) return;
    const revealKey = `${listFilter}:${activeSelectionKey}`;
    if (revealedSelectionRef.current === revealKey) return;
    const list = listRef.current;
    const row = rowRefs.current.get(activeSelectionKey);
    if (!list || !row) return;
    revealedSelectionRef.current = revealKey;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const next = sidebarScrollTopToReveal({
      scrollTop: list.scrollTop,
      viewportTop: listRect.top,
      viewportBottom: listRect.bottom,
      itemTop: rowRect.top,
      itemBottom: rowRect.bottom,
    });
    if (next !== list.scrollTop) list.scrollTop = next;
  }, [activeSelectionKey, hidden, listFilter, listIdentity]);

  const handleSelectFilter = useCallback(
    (filter: "grouped" | "ungrouped") =>
      dispatch({ type: "SET_WORKSPACE_LIST_FILTER", filter }),
    [dispatch],
  );

  const handleToggleRepository = useCallback(
    (project: Project) =>
      setRepositoryCollapsed(
        project.id,
        !collapsedRepositories.has(project.id),
      ),
    [collapsedRepositories],
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
    (workspace: WorkspaceNavigationTarget) => {
      // Warm the workbench and the existing conversation together.
      prefetchWorkspaceSurface(workspace);
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

  const handleArchiveWorkspace = useCallback(
    (workspace: Workspace) => void archiveWorkspace(workspace),
    [archiveWorkspace],
  );

  const pendingOnly =
    pendingProject &&
    !projects.some((project) => project.repoRoot === pendingProject.root)
      ? pendingProject
      : null;
  // The repository page validates its target like MainShellBody does: a
  // removed repository reads as the Dashboard it falls back to.
  const effectiveActivePage =
    activePage === "repo" &&
    !projects.some((project) => project.id === activeRepoId)
      ? "dashboard"
      : activePage;
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);

  // Persisted, drag-resizable width (module store → survives reloads).
  const railWidth = useHomeSidebarWidth();
  const railRef = useRef<HTMLDivElement | null>(null);
  const onResizePointerDown = useHomeSidebarResizeDrag(railRef);
  const { hintHandlers, hint } = useResizeHint(
    "Drag to resize · Double-click to reset",
  );
  const displayName = session?.user.name ?? null;

  const renderItem = (item: SidebarWorkspaceItem, grouped: boolean) => {
    const selectionKey = sidebarItemSelectionKey(item);
    const active = activeSelectionKey === selectionKey;
    return item.kind === "workspace" ? (
      <SidebarWorkspaceRow
        key={item.key}
        workspace={item.workspace}
        project={item.project}
        mixedRepositories={!groupedList}
        grouped={grouped}
        active={active}
        surfaceActive={!hidden}
        chatIds={
          chatIdsByWorkspace.get(item.workspace.id) ?? EMPTY_WORKSPACE_CHAT_IDS
        }
        draftChatIds={
          draftIdsByWorkspace.get(item.workspace.id) ?? EMPTY_WORKSPACE_CHAT_IDS
        }
        onSelect={handleSelectWorkspace}
        onPrefetch={handlePrefetchWorkspace}
        onArchive={handleArchiveWorkspace}
        rowRef={(node) => registerRow(selectionKey, node)}
        onOpenSettings={
          item.project.isGitRepository === false
            ? () =>
                dispatch({ type: "OPEN_REPO_PAGE", projectId: item.project.id })
            : undefined
        }
      />
    ) : (
      <PendingSidebarWorkspaceRow
        key={item.key}
        branch={item.pending.branch ?? undefined}
        kind={item.pending.kind}
        project={item.project}
        projectInteractive={item.pending.placement !== "cloud"}
        mixedRepositories={!groupedList}
        grouped={grouped}
        label={
          item.pending.label ?? (item.pending.branch
            ? branchDisplayName(item.pending.branch)
            : "New workspace")
        }
        active={active}
        rowRef={(node) => registerRow(selectionKey, node)}
      />
    );
  };

  return (
    <div
      ref={railRef}
      id={APP_SIDEBAR_ID}
      {...(hidden ? { inert: "" } : {})}
      aria-hidden={hidden || undefined}
      className={cn(
        "relative flex min-w-[220px] shrink-0",
        SIDEBAR_MAX_WIDTH_CLS,
        // Out of flow and invisible rather than display:none, which would
        // reset the workspace list's scroll offset while Settings is open.
        hidden && "pointer-events-none invisible absolute inset-y-0 left-0",
      )}
      style={{ width: `${railWidth}px` }}
      data-app-sidebar=""
    >
      <Surface
        as="nav"
        kind="sidebar"
        className="flex min-w-0 flex-1 flex-col overflow-hidden"
        aria-label="Workspace navigation"
      >
        {/* 40px title band: the macOS traffic lights sit in its first 80px
            (trafficLightPosition in electron/main.ts), the panel-left toggle
            right after them. The rest is a window drag handle carrying the
            app-level controls at its end: resources, then back and forward.
            These four 28px controls set the sidebar's 220px floor. */}
        <div
          ref={titleBandRef}
          className="flex h-10 shrink-0 items-center gap-1 pr-2"
        >
          <div className={TRAFFIC_LIGHT_RESERVE_CLS} aria-hidden="true" />
          <SidebarToggleButton collapsed={false} />
          <div className="ml-auto flex h-full shrink-0 items-center gap-1">
            {!hidden && <ResourceMonitor />}
            {!hidden && (
              <SidebarHistoryButtons
                scope={historyScope}
                onPrefetchWorkspace={handlePrefetchWorkspace}
              />
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-1 px-2">
          <OrganizationSwitcher
            onOrganizationChanged={() =>
              dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" })
            }
            onOpenSettings={() =>
              dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" })
            }
          />
          {/* Destinations sit 2px apart, like the workspace list's rows. */}
          <div className="flex flex-col gap-0.5">
            {/* Home is the Dashboard: every live workspace across repositories. */}
            <Button
              type="button"
              variant="ghost"
              aria-current={
                effectiveActivePage === "dashboard" ? "page" : undefined
              }
              data-state={
                effectiveActivePage === "dashboard" ? "active" : "inactive"
              }
              className={SIDEBAR_ENTRY_CLS}
              onClick={() =>
                dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" })
              }
            >
              <House strokeWidth={1.5} />
              <span className="truncate">Home</span>
            </Button>
            {/* Agent capabilities (MCP now; Skills / Plugins later), scoped User
              or per-repo inside the page itself. */}
            <Button
              type="button"
              variant="ghost"
              aria-current={
                effectiveActivePage === "customize" ? "page" : undefined
              }
              data-state={
                effectiveActivePage === "customize" ? "active" : "inactive"
              }
              className={SIDEBAR_ENTRY_CLS}
              onClick={() =>
                dispatch({ type: "SET_ACTIVE_PAGE", page: "customize" })
              }
            >
              <Blocks strokeWidth={1.5} />
              <span className="truncate">Customize</span>
            </Button>
            {/* An action, not a destination: Create never reads as selected,
              whether it or a repository's + opened the Create page. */}
            <Button
              type="button"
              variant="ghost"
              className={SIDEBAR_ENTRY_CLS}
              aria-label="Create workspace"
              onClick={() => openDispatcher(contextProject?.id)}
            >
              <Plus strokeWidth={1.5} />
              <span className="truncate">Create</span>
            </Button>
          </div>
        </div>

        <div
          className="bg-border1 mx-2 mt-2 h-px shrink-0"
          aria-hidden="true"
        />

        {/* Section header: the list's presentation lives behind its ⋯. */}
        {/* Only its ⋯ reacts to hover; the header itself is a quiet label. */}
        <div className="group/section mx-2 mt-2 flex h-8 shrink-0 items-center gap-1 pr-1 pl-2.5">
          <span className={cn(SECTION_LABEL_CLS, "min-w-0 flex-1")}>
            Workspaces
          </span>
          <DropdownMenu open={filterMenuOpen} onOpenChange={setFilterMenuOpen}>
            <Tooltip label="Filter workspaces" side="bottom">
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    SIDEBAR_ROW_ACTION_CLS,
                    !filterMenuOpen &&
                      "opacity-0 group-hover/section:opacity-100 focus-visible:opacity-100",
                  )}
                  aria-label="Filter workspaces"
                >
                  <Ellipsis strokeWidth={1.5} />
                </button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="start" sideOffset={5} className="w-44">
              {SIDEBAR_WORKSPACE_LIST_FILTERS.map((filter) => (
                <DropdownMenuItem
                  key={filter}
                  onSelect={() => handleSelectFilter(filter)}
                  aria-current={listFilter === filter ? "true" : undefined}
                >
                  <span>{filter === "grouped" ? "Grouped" : "Ungrouped"}</span>
                  {listFilter === filter && (
                    <Check className="text-fg2 ml-auto size-3.5" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
          aria-label={
            groupedList ? "Workspaces grouped by repository" : "Workspaces"
          }
          aria-busy={liveLoading || undefined}
          role="region"
        >
          {/* 2px between every repository and workspace row. An empty group
              (no workspaces, or collapsed without the selection) drops out
              of the flex flow so it cannot double that gap. */}
          <div className="flex flex-col gap-0.5">
            {entries.map((entry) => {
              if (entry.kind === "row") {
                return renderItem(entry.item, false);
              }
              if (entry.kind === "folder") {
                const selected =
                  effectiveActivePage === "repo" &&
                  activeRepoId === entry.project.id;
                const prefetch = () =>
                  prefetchSettingsForRepo(entry.project.repoRoot);
                return (
                  <Button
                    key={entry.key}
                    type="button"
                    variant="ghost"
                    className={SIDEBAR_ENTRY_CLS}
                    data-sidebar-folder={entry.project.id}
                    data-state={selected ? "active" : "inactive"}
                    aria-current={selected ? "page" : undefined}
                    onPointerEnter={prefetch}
                    onFocus={prefetch}
                    onClick={() =>
                      dispatch({
                        type: "OPEN_REPO_PAGE",
                        projectId: entry.project.id,
                      })
                    }
                  >
                    <Folder strokeWidth={1.5} />
                    <span className="truncate">{entry.project.name}</span>
                  </Button>
                );
              }
              const groupId = `sidebar-repository-${entry.project.id}`;
              const collapsed = collapsedRepositories.has(entry.project.id);
              return (
                <React.Fragment key={entry.key}>
                  <SidebarRepositoryHeader
                    project={entry.project}
                    collapsed={collapsed}
                    active={
                      effectiveActivePage === "repo" &&
                      activeRepoId === entry.project.id
                    }
                    opening={openingRoot === entry.project.repoRoot}
                    groupId={groupId}
                    onToggle={handleToggleRepository}
                  />
                  <div
                    id={groupId}
                    role="group"
                    aria-label={`${entry.project.name} workspaces`}
                    className="flex flex-col gap-0.5 empty:hidden"
                  >
                    {visibleRepositoryItems(
                      entry.items,
                      collapsed,
                      activeSelectionKey,
                    ).map((item) => renderItem(item, true))}
                  </div>
                </React.Fragment>
              );
            })}
            {pendingOnly && (
              <div
                className="text-fg2 flex h-7.5 min-w-0 items-center gap-2 rounded-md px-2 text-xs"
                role="status"
                aria-live="polite"
              >
                <ZerosSpinner size={14} label={`Opening ${pendingOnly.name}`} />
                <span className="min-w-0 truncate">{pendingOnly.name}</span>
              </div>
            )}
          </div>
        </div>

        {/* Profile card — identity + the Settings entry point (⌘, works too). */}
        <div className="border-border1 mx-2 flex shrink-0 items-center gap-2.5 border-t px-1 py-2.5">
          <span
            className="bg-bg2-hover text-fg1 text-xxs inline-flex size-6 shrink-0 items-center justify-center rounded-full font-medium"
            aria-hidden="true"
          >
            {profileInitials(displayName, email)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="text-fg1 truncate text-xs">
              {displayName ?? email ?? "Not signed in"}
            </span>
            {displayName && email && (
              <span className="text-muted-fg truncate text-xs">{email}</span>
            )}
          </span>
          <Tooltip label="Settings">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open settings"
              data-state={activePage === "settings" ? "active" : "inactive"}
              className="text-fg2 hover:text-fg1 data-[state=active]:text-fg1 shrink-0"
              onClick={() =>
                dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" })
              }
            >
              <Settings size={16} strokeWidth={1.5} />
            </Button>
          </Tooltip>
        </div>
      </Surface>
      {/* Right-edge resize seam — a 1px border line with a wider invisible
          hit strip. Drag to resize (persists per user); double-click resets. */}
      <div className="bg-border1 relative w-px shrink-0">
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          className="absolute -inset-x-[3px] inset-y-0 z-20 cursor-ew-resize select-none"
          onPointerDown={onResizePointerDown}
          onMouseDown={(e) => e.preventDefault()}
          onDoubleClick={(e) => {
            e.preventDefault();
            setHomeSidebarWidth(HOME_SIDEBAR_DEFAULT_PX);
          }}
          {...hintHandlers}
        />
        {hint}
      </div>
    </div>
  );
}
