import { useOrganizationProjects } from "../state/use-organization-projects";
import { projectGroupLookup } from "../state/project-identity";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
// ============================================
// COMPONENT: AppSidebar
// PURPOSE: The app's single left navigation — window chrome, organization,
//          Home destinations, Create, and every workspace, grouped by
//          repository (default), lifecycle status or as one mixed list.
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
//   │ Workspaces                [⋯] │  Group / Filter / Sort by
//   │ [W] Zeros          [⚙][⋯] [+] │  Repository grouping
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
  ChevronDown,
  ChevronRight,
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
import { ComposerDraftIndicator } from "../features/agent/composer-draft-indicator";
import {
  prefetchSettingsForRepo,
  usePrefetchSettings,
} from "../features/settings/use-settings";
import { filterRowsForOrganization, localWorkShowsEverywhere } from "../features/team/organization-capabilities";
import { OrganizationSwitcher } from "../features/team/organization-switcher";
import { getActiveOrganizationIdSnapshot, getTeamStoreState, useActiveOrganization } from "../features/team/team-store";
import { useMyUserId, useSharingOrganization } from "../platform/team-sharing-state";
import { useSharingOwners, useSharingSections } from "../state/cloud-workspace-creators";
import { pullRequestTarget } from "../state/workspace-repositories";
import { getPrIslandKind, usePrIslandKindsVersion } from "./pr/pr-island-state-store";
import { CONTROL_PLANE_URL } from "../features/team/control-plane";
import { useArchiveWorkspace } from "../state/archive-actions";
import { draftChatIdsByWorkspace } from "../state/composer-draft-presence";
import { createComposerDraftOwner, useCreateComposerHasDraft } from "../state/create-composer-drafts";
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
import { useOrganizationDestination } from "../state/organization-navigation";
import {
  setSidebarHiddenPlacements, setSidebarGroupCollapsed, setSidebarRepositoryIds, setSidebarStatusCollapsed, setSidebarWorkspaceSort,
  sidebarHiddenPlacements, sidebarRepositoryFilterOwner, sidebarRepositoryIds, useSidebarListPreferences,
} from "../state/sidebar-list-preferences";
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
import { StatusIcon } from "../shared/ui/primitives/status-icon";
import { toast } from "../shared/ui/primitives/elements";
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
import { useInternalFeatureActive } from "../features/settings/internal-features";
import {
  setRepositoryCollapsed,
  useCollapsedRepositories,
} from "./sidebar-collapsed-repositories";
import { SidebarHistoryButtons } from "./sidebar-history-buttons";
import type { SidebarHistoryScope } from "./sidebar-navigation-history";
import {
  SidebarRepositoryHeader,
} from "./sidebar-repository-header";
import {
  buildSidebarSharingSections,
  buildSidebarWorkspaceEntries,
  rowsShownForPlacements,
  type SidebarWorkspaceEntry,
  sidebarItemSelectionKey,
  sidebarScrollTopToReveal,
  sidebarWorkspaceItems,
  sidebarWorkspaceListFilter,
  visibleRepositoryItems,
  type SidebarWorkspaceItem,
  type SidebarWorkspaceListFilter,
} from "./sidebar-workspace-model";
import { SidebarWorkspaceMenu } from "./sidebar-workspace-menu";
import { useSidebarWorkspaceSignals } from "./use-sidebar-workspace-signals";
import { SidebarArchivedSection } from "./sidebar-archived-section";
import {
  agentStatusOf,
  extraGroupOf,
  filterSidebarWorkspaces,
  sidebarViewFilters,
  workspacePullRequests,
  PR_FILTER_LABELS,
  sidebarWorkspaceComparator,
} from "./sidebar-view-model";
import {
  SIDEBAR_AGENT_STATUS_FILTERS,
  SIDEBAR_PR_FILTERS,
  setSidebarSectionCollapsed,
  type SidebarAgentStatusFilter,
  type SidebarOwnerFilter,
  type SidebarPrFilter,
  type SidebarThenBy,
} from "../state/sidebar-list-preferences";
import { LIFECYCLE_STATUSES, statusMeta } from "../shared/lib/workspace-status";
import { useSidebarWorkspaceActivity } from "./sidebar-workspace-activity";
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
import { useWorkspaceNavigationHotkeys } from "./use-workspace-navigation-hotkeys";
import { useHomeSidebarResizeDrag } from "./use-home-sidebar-drag";
import { useResizeHint } from "./use-resize-hint";
import { warmWorkspaceFiles } from "./workspace-files-cache";
import { resolveRepoWorkspaceDestination, workspaceLabel } from "./workspace-tabs";
import { Surface } from "@/renderer/shared/ui/layout/surface";
import { Avatar, AvatarFallback } from "@/renderer/shared/ui/primitives/avatar";
import { initialsOf } from "@/renderer/shared/lib/initials";

// --- CONSTANTS ---

// One shared destination-row shape, mirroring the Settings rail's entry
// (settings-page.tsx SIDEBAR_ENTRY_CLS) so both navigations read as the same
// control: 32px, fg2 at rest on the surface hover, fg1 on bg2-highlight when
// selected. Icons are 14px on fg3 at the 16px icon column (8px list inset +
// 8px padding, no border); selection lifts them to fg2. Rows never shift
// width. `[&_svg]:` beats the primitive's own icon size through twMerge.
const SIDEBAR_ENTRY_CLS =
  "flex h-8 w-full min-w-0 items-center justify-start gap-2 rounded-md border-0 bg-transparent px-2 py-0 text-left text-xs leading-4.5 font-normal text-fg2 transition-colors duration-120 ease-out hover:bg-(--surface-hover) hover:text-fg1 data-[state=active]:bg-bg2-highlight data-[state=active]:text-fg1 data-[state=active]:hover:bg-bg2-highlight [&_svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-fg3 data-[state=active]:[&>svg]:text-fg2";
// The list's section label: 12/16 medium on fg3, like Settings' group labels.
const SECTION_LABEL_CLS = "select-none truncate text-3xxs leading-4 font-medium text-fg3";
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


// --- ROOT COMPONENT ---

const NO_HIDDEN_PLACEMENTS: readonly ("local" | "cloud")[] = [];

// A child workspace indents 16px per level under its parent; the parent's
// own leading slot toggles its children (sidebar-workspace-row.tsx).
const CHILD_INDENT_CLS = ["", "ml-4", "ml-8", "ml-12"] as const;

function nestedWorkspaceRow(
  item: Extract<SidebarWorkspaceItem, { kind: "workspace" }>,
  row: React.ReactElement,
): React.ReactElement {
  const depth = item.depth ?? 0;
  if (!depth) return row;
  return (
    <div key={item.key} className={cn("min-w-0", CHILD_INDENT_CLS[Math.min(depth, CHILD_INDENT_CLS.length - 1)])}>{row}</div>
  );
}

export function AppSidebar({ hidden = false }: { hidden?: boolean }) {
  const activeResolution = useActiveWorkspace();
  const chats = useChats();
  const activePage = useActivePage();
  const activeRepoId = useActiveRepoId();
  const createWorkspaceProjectId = useCreateWorkspaceProjectId();
  const activeOrganization = useActiveOrganization();
  const restoreOrganizationDestination = useOrganizationDestination(activeOrganization);
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
  const { session, email, userId } = useAuth();
  const filterOwner = sidebarRepositoryFilterOwner(userId ?? getTeamStoreState().me?.user.id, getActiveOrganizationIdSnapshot());
  const createDraftOwner = createComposerDraftOwner({
    backend: CONTROL_PLANE_URL,
    userId: userId ?? getTeamStoreState().me?.user.id,
    organizationId: getActiveOrganizationIdSnapshot(),
  });
  // unified-workspaces: Create's This Mac drafts belong to the device under every owner.
  const hasLocalCreateDraft = useCreateComposerHasDraft(
    localWorkShowsEverywhere() && createDraftOwner !== "local" ? "local" : null,
  );
  const hasCreateDraft = useCreateComposerHasDraft(createDraftOwner) || hasLocalCreateDraft;
  const showCreateDraft = activePage !== "create" && hasCreateDraft;
  const preferences = useSidebarListPreferences();
  const repositoryIds = sidebarRepositoryIds(filterOwner);
  const unifiedPlacements = localWorkShowsEverywhere();
  const hiddenPlacements = unifiedPlacements ? sidebarHiddenPlacements(filterOwner) : NO_HIDDEN_PLACEMENTS;

  usePruneLegacyPhantomProjects();
  useSyncProjectsToEngine();
  usePrefetchSettings(projectRepoRoots);
  useNativeRuntimeNotice();

  const activeProject = useMemo(
    () => findProjectForFolder(activeFolder, projects),
    [activeFolder, projects],
  );

  // Older builds persisted Active and repository-only presentations. Paint the
  // folded value immediately and persist it once, so the stored filter always
  // names one of the presentations this navigation offers.
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
  // Team sharing: the sidebar lists Pinned, the viewer's own and Following;
  // other teammates' workspaces stay on Home (and keep no sidebar effects).
  const sharingOrganizationId =
    activeOrganization && !activeOrganization.isPersonal ? activeOrganization.id : null;
  const sharing = useSharingOrganization(sharingOrganizationId);
  const me = useMyUserId();
  const sectionOf = useSharingSections(me);
  const sharingOwnerOf = useSharingOwners(me);
  const liveVisibleWorkspaces = useLiveVisible(accessibleWorkspaces);
  const realWorkspaces = useMemo(
    () => sharing ? liveVisibleWorkspaces.filter(workspace => sectionOf(workspace) !== null) : liveVisibleWorkspaces,
    [liveVisibleWorkspaces, sectionOf, sharing],
  );
  const activeAtByWorkspaceId = useSidebarWorkspaceActivity(filterOwner, realWorkspaces, chats, !hidden);
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

  // Parents the user toggled away from the "Expand child workspaces" default.
  const [toggledParentIds, setExpandedWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set());
  const expandChildren = preferences.view.expandChildren;
  useEffect(() => setExpandedWorkspaceIds(new Set()), [expandChildren]);
  const expandedWorkspaceIds = useMemo<ReadonlySet<string>>(
    () => expandChildren
      ? new Set(realWorkspaces.flatMap(workspace => toggledParentIds.has(workspace.id) ? [] : [workspace.id]))
      : toggledParentIds,
    [expandChildren, realWorkspaces, toggledParentIds],
  );
  const toggleChildWorkspaces = useCallback((id: string) => setExpandedWorkspaceIds((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  }), []);
  const view = preferences.view;
  const signalLookup = useSidebarWorkspaceSignals(chatIdsByWorkspace, draftIdsByWorkspace, !hidden);
  const signalOfWorkspace = useCallback((workspace: Workspace) => signalLookup(workspace.id), [signalLookup]);
  const ownerOf = useCallback(
    (workspace: Workspace): SidebarOwnerFilter | null => {
      if (!sharing) return "mine";
      return sharingOwnerOf(workspace);
    },
    [sharingOwnerOf, sharing],
  );
  const prIslandVersion = usePrIslandKindsVersion();
  const islandOf = useMemo(() => {
    void prIslandVersion;
    return (workspace: Workspace) => getPrIslandKind(pullRequestTarget(workspace), workspace.prNumber);
  }, [prIslandVersion]);
  const viewArgs = useMemo(() => {
    const label = (workspace: Workspace) => workspaceLabel(workspace);
    const base = sidebarWorkspaceComparator({
      sort: preferences.sort,
      direction: view.direction,
      needsYouFirst: view.needsYouFirst,
      label,
      activeAt: (workspace) => activeAtByWorkspaceId.get(workspace.id),
      needsYou: (workspace) => signalLookup(workspace.id).awaiting !== null,
    });
    const groupOf = (grouping: SidebarThenBy, workspace: Workspace) =>
      grouping === "repository"
        ? { order: 0, key: workspace.repoSlug ?? "" }
        : grouping === "status"
          ? { order: LIFECYCLE_STATUSES.findIndex((status) => status.value === statusMeta(workspace.status).value), key: "" }
          : extraGroupOf(grouping, workspace, { signal: signalLookup(workspace.id), activeAt: activeAtByWorkspaceId.get(workspace.id), owner: ownerOf(workspace), island: islandOf(workspace) });
    const thenBy = view.thenBy;
    const compare = thenBy
      ? (a: Workspace, b: Workspace) => {
          const ga = groupOf(thenBy, a);
          const gb = groupOf(thenBy, b);
          return ga.order - gb.order || ga.key.localeCompare(gb.key) || base(a, b);
        }
      : base;
    const grouping = view.grouping;
    return {
      compare,
      hideEmptyGroups: view.hideEmptyGroups,
      ...(grouping
        ? {
            extraGroup: (item: SidebarWorkspaceItem) =>
              item.kind === "pending"
                ? grouping === "placement" && item.pending.placement === "cloud"
                  ? { key: "cloud", label: "Cloud", order: 1 }
                  : grouping === "placement"
                    ? { key: "local", label: "This Mac", order: 0 }
                    : grouping === "recency"
                      ? { key: "today", label: "Today", order: 0 }
                      : grouping === "pr"
                        ? { key: "none", label: PR_FILTER_LABELS.none, order: 5 }
                        : { key: "mine", label: "Mine", order: 0 }
                : extraGroupOf(grouping, item.workspace, {
                    signal: signalLookup(item.workspace.id),
                    activeAt: activeAtByWorkspaceId.get(item.workspace.id),
                    owner: ownerOf(item.workspace),
                    island: islandOf(item.workspace),
                  }),
          }
        : {}),
    };
  }, [activeAtByWorkspaceId, islandOf, ownerOf, preferences.sort, signalLookup, view.direction, view.grouping, view.hideEmptyGroups, view.needsYouFirst, view.thenBy]);
  const menuCounts = useMemo(() => {
    const statuses = Object.fromEntries(SIDEBAR_AGENT_STATUS_FILTERS.map(status => [status, 0])) as Record<SidebarAgentStatusFilter, number>;
    const prStates = Object.fromEntries(SIDEBAR_PR_FILTERS.map(state => [state, 0])) as Record<SidebarPrFilter, number>;
    for (const workspace of rowsShownForPlacements(realWorkspaces, hiddenPlacements)) {
      statuses[agentStatusOf(workspace, signalLookup(workspace.id))] += 1;
      const tones = new Set(workspacePullRequests(workspace, islandOf(workspace)).map(pull => pull.tone));
      if (tones.size === 0) prStates.none += 1;
      for (const tone of tones) prStates[tone] += 1;
    }
    return { statuses, prStates };
  }, [hiddenPlacements, islandOf, realWorkspaces, signalLookup]);
  const buildSections = useCallback((expanded: ReadonlySet<string>) => {
    const args = {
      expandedWorkspaceIds: expanded,
      filter: listFilter,
      sort: preferences.sort,
      repositoryIds,
      activity: { activeAtByWorkspaceId },
      projects,
      workspaces: filterSidebarWorkspaces(rowsShownForPlacements(realWorkspaces, hiddenPlacements), view, signalOfWorkspace, sharing ? ownerOf : undefined, islandOf),
      pending: rowsShownForPlacements(dedupedPendingCreates, hiddenPlacements),
      ...(unifiedPlacements ? { projectGroupOf: projectGroupLookup(projects) } : {}),
      ...viewArgs,
    };
    return sharing
      ? buildSidebarSharingSections({ ...args, sectionOf })
      : [{ id: null, label: "", entries: buildSidebarWorkspaceEntries(args) }];
  }, [dedupedPendingCreates, listFilter, preferences.sort, repositoryIds, hiddenPlacements, activeAtByWorkspaceId, projects, realWorkspaces, sharing, sectionOf, unifiedPlacements, view, signalOfWorkspace, ownerOf, islandOf, viewArgs]);
  const sections = useMemo(() => buildSections(expandedWorkspaceIds), [buildSections, expandedWorkspaceIds]);
  const entries = useMemo(() => sections.flatMap(section => section.entries), [sections]);
  const listedItems = useMemo(() => sidebarWorkspaceItems(entries), [entries]);
  const navigableWorkspaces = useMemo(
    () => listedItems.flatMap(item => item.kind === "workspace" ? [item.workspace] : []),
    [listedItems],
  );
  // Repository filtering also bounds Back/Forward destinations; collapse does
  // not remove a destination from history.
  // Child workspaces under a collapsed parent stay history destinations,
  // bounded by the same repository, placement and list filters.
  const historyWorkspaces = useMemo(() => {
    if (!realWorkspaces.some(workspace => workspace.parentWorkspaceId)) return navigableWorkspaces;
    const allExpanded = new Set(realWorkspaces.map(workspace => workspace.id));
    return sidebarWorkspaceItems(buildSections(allExpanded).flatMap(section => section.entries))
      .flatMap(item => item.kind === "workspace" ? [item.workspace] : []);
  }, [buildSections, navigableWorkspaces, realWorkspaces]);
  const historyScope = useMemo<SidebarHistoryScope>(() => ({
    projects,
    workspaces: historyWorkspaces,
    pendingCreates: listedItems.flatMap(item => item.kind === "pending" ? [item.pending] : []),
  }), [listedItems, historyWorkspaces, projects]);

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
    (filter: SidebarWorkspaceListFilter) =>
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

  const handleCreateWorkspace = useCallback(
    () => openDispatcher(contextProject?.id),
    [contextProject?.id, openDispatcher],
  );
  useWorkspaceNavigationHotkeys({
    workspaces: navigableWorkspaces,
    onSelect: handleSelectWorkspace,
    onCreate: handleCreateWorkspace,
  });

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

  // Persisted, drag-resizable width (module store → survives reloads).
  const railWidth = useHomeSidebarWidth();
  const resourceSummary = useInternalFeatureActive("resourceSummary");
  const railRef = useRef<HTMLDivElement | null>(null);
  const onResizePointerDown = useHomeSidebarResizeDrag(railRef);
  const { hintHandlers, hint } = useResizeHint(
    "Drag to resize · Double-click to reset",
  );
  const displayName = session?.user.name ?? null;

  const listFiltered = repositoryIds.length > 0 || hiddenPlacements.length > 0 || sidebarViewFilters(preferences.view);
  const workspaceMenu = hidden ? null : (
    <SidebarWorkspaceMenu
      key={filterOwner}
      active={!hidden}
      projects={projects}
      grouping={listFilter}
      sort={preferences.sort}
      view={preferences.view}
      repositoryIds={repositoryIds}
      sharing={sharing}
      counts={menuCounts}
      onGroupingChange={handleSelectFilter}
      onSortChange={setSidebarWorkspaceSort}
      onRepositoryIdsChange={ids => setSidebarRepositoryIds(filterOwner, ids)}
      {...(unifiedPlacements ? {
        hiddenPlacements,
        onHiddenPlacementsChange: (hidden: readonly ("local" | "cloud")[]) => setSidebarHiddenPlacements(filterOwner, hidden),
      } : {})}
    />
  );

  const renderEntry = (entry: SidebarWorkspaceEntry, section: string | null) => {
    if (entry.kind === "row") {
      return renderItem(entry.item, false);
    }
    if (entry.kind === "status" || entry.kind === "group") {
      const status = entry.kind === "status" ? entry.status : null;
      const groupKey = status ? `status:${status.value}` : entry.key;
      const collapsed = status
        ? preferences.collapsedStatuses.includes(status.value)
        : view.collapsedGroups.includes(groupKey);
      const label = entry.kind === "status" ? entry.status.label : entry.label;
      const groupId = `sidebar-${section ? `${section}-` : ""}${status ? `status-${status.value}` : entry.key.replace(/[^a-z0-9-]/gi, "-")}`;
      return (
        <React.Fragment key={entry.key}>
          <Button type="button" variant="ghost"
            className={cn(SIDEBAR_ENTRY_CLS, "font-medium")}
            data-sidebar-status={status?.value}
            data-sidebar-group={status ? undefined : entry.key}
            aria-expanded={!collapsed} aria-controls={groupId}
            onClick={() => status
              ? setSidebarStatusCollapsed(status.value, !collapsed)
              : setSidebarGroupCollapsed(groupKey, !collapsed)}>
            {status && (
              <span className="inline-flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
                <StatusIcon status={status.value} className="size-3.5" />
              </span>
            )}
            <span className="min-w-0 truncate">{label}</span>
            <span className="text-muted-fg ml-auto text-3xxs tabular-nums">{entry.items.length}</span>
            {collapsed ? <ChevronRight strokeWidth={1.5} aria-hidden="true" /> : <ChevronDown strokeWidth={1.5} aria-hidden="true" />}
          </Button>
          <div id={groupId} role="group" aria-label={`${label} workspaces`}
            className="flex flex-col gap-0.5 empty:hidden">
            {visibleRepositoryItems(entry.items, collapsed, activeSelectionKey).map(item => renderItem(item, true))}
          </div>
        </React.Fragment>
      );
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
          {/* The 16px box puts the name on the rows' 40px column. */}
          <span className={cn("inline-flex size-4 shrink-0 items-center justify-center", selected ? "text-fg2" : "text-fg3")} aria-hidden="true">
            <Folder strokeWidth={1.5} />
          </span>
          <span className="truncate">{entry.project.name}</span>
        </Button>
      );
    }
    const groupId = `sidebar-${section ? `${section}-` : ""}repository-${entry.project.id}`;
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
  };

  const renderItem = (item: SidebarWorkspaceItem, grouped: boolean) => {
    const selectionKey = sidebarItemSelectionKey(item);
    const active = activeSelectionKey === selectionKey;
    return item.kind === "workspace" ? nestedWorkspaceRow(item, (
      <SidebarWorkspaceRow
        key={item.key}
        workspace={item.workspace}
        project={item.project}
        grouped={grouped}
        active={active}
        surfaceActive={!hidden}
        previewOwner={filterOwner}
        activeAt={activeAtByWorkspaceId.get(item.workspace.id)}
        chatIds={
          chatIdsByWorkspace.get(item.workspace.id) ?? EMPTY_WORKSPACE_CHAT_IDS
        }
        draftChatIds={
          draftIdsByWorkspace.get(item.workspace.id) ?? EMPTY_WORKSPACE_CHAT_IDS
        }
        compact={preferences.view.compact}
        showProjectName={preferences.view.showProjectName && !preferences.view.compact}
        depth={item.depth}
        sameProjectAsParent={item.sameProjectAsParent}
        childCount={item.childCount}
        childrenExpanded={item.expanded}
        onToggleChildren={item.childCount ? () => toggleChildWorkspaces(item.workspace.id) : undefined}
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
    )) : (
      <PendingSidebarWorkspaceRow
        key={item.key}
        kind={item.pending.kind}
        project={item.project}
        projectInteractive={item.pending.placement !== "cloud"}
        cloud={item.pending.placement === "cloud"}
        grouped={grouped}
        label={
          item.pending.label ?? (item.pending.branch
            ? branchDisplayName(item.pending.branch)
            : "New workspace")
        }
        active={active}
        compact={preferences.view.compact}
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
        "relative flex shrink-0",
        // Preserve the saved width; only the live memory label needs extra room.
        resourceSummary ? "min-w-[280px]" : "min-w-[220px]",
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
            The Internal memory summary raises the floor to fit its label. */}
        <div
          data-tauri-drag-region
          className="flex h-10 shrink-0 items-center gap-1 pr-3"
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
            onOrganizationChanged={restoreOrganizationDestination}
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
              className={cn(SIDEBAR_ENTRY_CLS, "[&_[data-draft-icon]]:size-3")}
              aria-label="Create workspace"
              aria-description={showCreateDraft ? "Unsent draft" : undefined}
              onClick={handleCreateWorkspace}
              aria-keyshortcuts="Meta+N"
            >
              <Plus strokeWidth={1.5} />
              <span className="truncate">Create</span>
              <span className="ml-auto inline-flex size-4 shrink-0 items-center justify-center">
                {showCreateDraft && <ComposerDraftIndicator />}
              </span>
            </Button>
          </div>
        </div>

        <div
          className="bg-border1 mx-2 mt-2 h-px shrink-0"
          aria-hidden="true"
        />

        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2"
          aria-label={
            groupedList ? "Workspaces grouped by repository"
              : listFilter === "status" ? "Workspaces grouped by status" : "Workspaces"
          }
          aria-busy={liveLoading || undefined}
          role="region"
        >
          {/* 2px between every repository and workspace row. An empty group
              (no workspaces, or collapsed without the selection) drops out
              of the flex flow so it cannot double that gap. */}
          <div className="flex flex-col gap-0.5">
            {sections.map((section) => {
              const id = section.id ?? "mine";
              const collapsed = preferences.view.collapsedSections.includes(id);
              const items = sidebarWorkspaceItems(section.entries);
              const sectionId = `sidebar-section-${id}`;
              return (
                <React.Fragment key={id}>
                  <div className="group/section flex h-8 shrink-0 items-center gap-1 pt-1 first:pt-0" data-sidebar-section={id}>
                    <Button type="button" variant="ghost"
                      className="hover:bg-transparent h-7 min-w-0 flex-1 justify-start gap-1.5 rounded-md border-0 px-2 font-normal [&_svg]:size-3 [&_svg]:text-fg3"
                      aria-expanded={!collapsed} aria-controls={sectionId}
                      onClick={() => setSidebarSectionCollapsed(id, !collapsed)}>
                      <span className={cn(SECTION_LABEL_CLS, "min-w-0")}>{section.id === null ? "My workspaces" : section.label}</span>
                      <span className="text-muted-fg text-3xxs tabular-nums">{items.length}</span>
                      <span className="ml-auto inline-flex shrink-0" aria-hidden="true">
                        {collapsed ? <ChevronRight strokeWidth={1.5} /> : <ChevronDown strokeWidth={1.5} />}
                      </span>
                    </Button>
                    {id === "mine" && workspaceMenu}
                  </div>
                  <div id={sectionId} role="group" aria-label={section.id === null ? "My workspaces" : section.label} className="flex flex-col gap-0.5 empty:hidden">
                    {collapsed
                      ? items.filter(item => sidebarItemSelectionKey(item) === activeSelectionKey).map(item => renderItem(item, false))
                      : section.entries.map((entry) => renderEntry(entry, section.id))}
                  </div>
                </React.Fragment>
              );
            })}
            {preferences.view.showArchived && !hidden && (
              <SidebarArchivedSection
                organization={activeOrganization}
                collapsed={preferences.view.collapsedSections.includes("archived")}
                compact={preferences.view.compact}
                onToggle={(collapsed) => setSidebarSectionCollapsed("archived", collapsed)}
                labelClassName={SECTION_LABEL_CLS}
              />
            )}
            {pendingOnly && (
              <div
                className="text-fg2 flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-xs"
                role="status"
                aria-live="polite"
              >
                <span className="inline-flex size-4 shrink-0 items-center justify-center">
                  <ZerosSpinner size={14} label={`Opening ${pendingOnly.name}`} />
                </span>
                <span className="min-w-0 truncate">{pendingOnly.name}</span>
              </div>
            )}
            {listFiltered && listedItems.length === 0 && !liveLoading && (
              <div className="px-2 py-2 text-xs text-fg3" role="status">
                No workspaces match these filters
              </div>
            )}
          </div>
        </div>

        {/* Profile row — identity + the Settings entry point (⌘, works too).
            A fixed 48px whether or not there is an email line. */}
        <div className="border-border1 mx-2 flex h-12 shrink-0 items-center gap-2 border-t px-1">
          <Avatar size="sm" aria-hidden="true">
            <AvatarFallback>{initialsOf(displayName?.trim() || email)}</AvatarFallback>
          </Avatar>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-fg1 truncate text-xs leading-4">
              {displayName ?? email ?? "Not signed in"}
            </span>
            {displayName && email && (
              <span className="text-fg3 truncate text-3xxs leading-4">{email}</span>
            )}
          </span>
          <IconButton
            type="button"
            size="standard"
            label="Open settings"
            data-state={activePage === "settings" ? "active" : "inactive"}
            className="text-fg2 hover:text-fg1 data-[state=active]:text-fg1 shrink-0"
            onClick={() =>
              dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" })
            }
          >
            <Settings size={16} strokeWidth={1.5} />
          </IconButton>
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
