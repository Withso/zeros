import { useMemo, useState, useSyncExternalStore } from "react";
import { isFeatureEnabled } from "../config/release-channel";
import { useAgentSessions } from "../features/agent/sessions-hooks";
import { isFeedbackConfigured } from "../features/feedback/submit-feedback";
import {
  isAgentControlFeatureActive,
  useAgentControlFeatureActive,
} from "../features/settings/agent-control-rollout";
import {
  isExperimentalEnabled,
  useExperimentalFeature,
} from "../features/settings/experimental-features";
import { requestUserSettingsSection } from "../features/settings/settings-navigation";
import { canCreateWorkspaceIn } from "../features/team/organization-capabilities";
import { hasCloudWorkspaceAccountAccess } from "../features/team/cloud-workspace-account-access";
import {
  getActiveOrganizationIdSnapshot,
  getOrganizationStoreGeneration,
  getTeamStoreState,
  useActiveOrganization,
  useTeams,
} from "../features/team/team-store";
import { revealInFinder } from "../platform/app";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { isNativeRuntime } from "../platform/runtime";
import { copyToClipboardWithFallback } from "../shared/lib/clipboard";
import { setPrefs } from "../shared/theme/store";
import { toast } from "../shared/ui/primitives/elements";
import {
  cloudWorkspaceDocument,
  getCloudWorkspaceDocuments,
  subscribeCloudWorkspaces,
} from "../state/cloud-workspace-catalog";
import { requestCloudWorkspaceOpen } from "../state/cloud-workspace-open-intent";
import { useLiveVisible } from "../state/live-workspace-selectors";
import { usePendingWorkspacesStore } from "../state/pending-workspaces";
import { spawnNewChatTab } from "../state/spawn-default-chat";
import { spawnTerminalTab } from "../state/spawn-terminal-tab";
import {
  selectActiveFolder,
  useActivePage,
  useActiveWorkbenchTabId,
  useChats,
  useWorkbenchTabs,
  useWorkspaceDispatch,
  useWorkspaceStore,
} from "../state/store";
import { useActiveWorkspace } from "../state/use-active-workspace";
import {
  cloudWorkspaceCanEdit,
  useCloudWorkspaceCanEdit,
} from "../state/use-cloud-workspace-can-edit";
import { useFolderWorkspaces } from "../state/use-folder-workspaces";
import { useOpenWorkspace } from "../state/use-open-workspace";
import {
  peekWorkspacesFor,
  useArchivedWorkspaces,
  useLiveWorkspaces,
  useProjects,
} from "../state/use-projects";
import {
  selectWorkspaceHistory,
  workspaceIsReadOnly,
} from "../state/workspace-history";
import { workbenchScopeForFolder } from "../state/workspace-store";
import { useAddProject } from "./add-project-provider";
import { CommandPalette } from "./command-palette";
import { useCommandPaletteFiles } from "./command-palette-files";
import {
  actionPaletteEntries,
  chatPaletteEntries,
  filePaletteEntries,
  paletteCapabilities,
  paletteWorkspaceForFolder,
  paletteWorkspacesForOwner,
  settingsPaletteEntries,
  workspacePaletteEntries,
  type PaletteAction,
  type PaletteCategory,
  type PaletteEntry,
  type PaletteWorkspaceFilter,
} from "./command-palette-model";
import { prepareChatView } from "./conversation/chat-intent";
import { requestFeedbackDialog } from "./feedback-controller";
import { prefetchWorkspaceSurface } from "./prefetch-workspace-surface";
import { toggleSidebarCollapsed } from "./sidebar-collapsed";
import { useTerminalStore } from "./terminal/terminal-store";
import { buildDirectFileOpenAction } from "./workbench/direct-file-open";
import {
  createChangesTab,
  createEmptyFilesTab,
  createReviewTab,
  defaultScopeFor,
} from "./workbench/tab-model";
import { useOpenBrowserInWorkbench } from "./workbench/use-open-browser";

interface Props {
  onDismiss: () => void;
  onShowShortcuts: () => void;
  revealWorkbench: () => void;
  toggleWorkbench: () => void;
}

/** Also read at activation time: a stale row cannot navigate after an owner,
 * account, or route change that has not reached React's next commit yet. */
export function commandPaletteIdentity(): string {
  const state = useWorkspaceStore.getState();
  return JSON.stringify([
    getOrganizationStoreGeneration(),
    getTeamStoreState().me?.user.id ?? null,
    getActiveOrganizationIdSnapshot(),
    state.activePage,
    selectActiveFolder(state),
  ]);
}

export function CommandPaletteController(props: Props) {
  // Subscriptions belong to the open overlay only. The key resets its search,
  // async consumers and selection synchronously on every destination change.
  useTeams();
  useActiveOrganization();
  useActivePage();
  useWorkspaceStore(selectActiveFolder);
  const identity = commandPaletteIdentity();
  return (
    <CommandPaletteSession key={identity} identity={identity} {...props} />
  );
}

function CommandPaletteSession({
  identity,
  onDismiss,
  onShowShortcuts,
  revealWorkbench,
  toggleWorkbench,
}: Props & { identity: string }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<PaletteCategory>("all");
  const [workspaceFilter, setWorkspaceFilter] =
    useState<PaletteWorkspaceFilter>("active");
  const [openedAt] = useState(Date.now);
  const dispatch = useWorkspaceDispatch();
  const sessions = useAgentSessions();
  const addProject = useAddProject();
  const openWorkspace = useOpenWorkspace();
  const openBrowser = useOpenBrowserInWorkbench(revealWorkbench);
  const organization = useActiveOrganization();
  const ownerId = getActiveOrganizationIdSnapshot();
  const localOwner = ownerId === null;
  const { projects } = useProjects();
  const live = useLiveWorkspaces();
  const archives = useArchivedWorkspaces();
  const listed = useFolderWorkspaces(live.workspaces, projects);
  const active = useActiveWorkspace();
  const page = useActivePage();
  const chats = useChats();
  const tabs = useWorkbenchTabs();
  const activeTabId = useActiveWorkbenchTabId();
  const activeFile = tabs.find((tab) => tab.id === activeTabId)?.filePath;
  const [terminalAgents] = useExperimentalFeature("terminalAgents");
  const computerUseActive = useAgentControlFeatureActive("computerUse");
  const simulatorsActive = useAgentControlFeatureActive("simulators");
  useSyncExternalStore(
    subscribeCloudWorkspaces,
    getCloudWorkspaceDocuments,
    getCloudWorkspaceDocuments,
  );
  const canEdit = useCloudWorkspaceCanEdit(active.folder ?? undefined);
  const cloudTarget = parseCloudWorkspaceKey(active.folder ?? undefined);
  const cloudStatus = cloudTarget
    ? cloudWorkspaceDocument(cloudTarget)?.status
    : undefined;

  const allWorkspaces = useMemo(() => {
    const history = selectWorkspaceHistory(listed, archives.workspaces);
    return [
      ...new Map(
        [
          ...(active.workspace ? [active.workspace] : []),
          ...history,
          ...listed,
        ].map((workspace) => [workspace.id, workspace]),
      ).values(),
    ];
  }, [listed, archives.workspaces, active.workspace]);
  const owned = useMemo(
    () => paletteWorkspacesForOwner(allWorkspaces, organization, ownerId),
    [allWorkspaces, organization, ownerId],
  );
  const visibleLive = useLiveVisible(owned);
  const visible = useMemo(
    () => [...visibleLive, ...owned.filter(workspaceIsReadOnly)],
    [visibleLive, owned],
  );
  const resolvedActive = active.folder
    ? paletteWorkspaceForFolder(active.folder, allWorkspaces)
    : null;
  const ownedActive =
    resolvedActive && visible.some((row) => row.id === resolvedActive.id)
      ? resolvedActive
      : null;
  const capabilityInput = {
    workspace: ownedActive,
    folder: active.folder,
    onWorkspacePage: page === "workspace",
    loading: active.loading,
    localOwner,
    native: isNativeRuntime(),
    cloudCanEdit: canEdit,
    cloudStatus,
    createWorkspace: localOwner || canCreateWorkspaceIn(organization, "cloud"),
    terminalAgents,
    activeFile: !!activeFile,
    feedback: isFeedbackConfigured(),
  };
  const capabilities = paletteCapabilities(capabilityInput);
  const settingsAvailability = {
    local: localOwner,
    cloudEnabled: isFeatureEnabled("cloud-workspaces"),
    terminalAgentsEnabled: terminalAgents,
    computerUseActive,
    simulatorsActive,
    internalUser: false,
  };
  const filesEnabled =
    capabilities.workspace && (category === "all" || category === "files");
  const files = useCommandPaletteFiles(active.folder, filesEnabled);
  const recentFiles = useMemo(
    () => tabs.flatMap((tab) => (tab.filePath ? [tab.filePath] : [])),
    [tabs],
  );
  const workspaceEntries = useMemo(
    () =>
      workspacePaletteEntries(
        visible,
        projects,
        category === "workspaces" ? workspaceFilter : "active",
      ),
    [visible, projects, category, workspaceFilter],
  );
  const chatEntries = useMemo(
    () => chatPaletteEntries(chats, visible, allWorkspaces, openedAt),
    [chats, visible, allWorkspaces, openedAt],
  );
  const fileEntries = useMemo(
    () =>
      filesEnabled && active.folder
        ? filePaletteEntries(active.folder, files.files, query, recentFiles)
        : [],
    [filesEnabled, active.folder, files.files, query, recentFiles],
  );
  const entries = [
    ...workspaceEntries,
    ...chatEntries,
    ...fileEntries,
    ...actionPaletteEntries(capabilities),
    ...settingsPaletteEntries(settingsAvailability),
  ];
  const current = () => identity === commandPaletteIdentity();

  const runAction = (action: PaletteAction): unknown => {
    const folder = active.folder;
    const scope = workbenchScopeForFolder(folder);
    const workbench =
      useWorkspaceStore.getState().workbenchByScope[scope] ??
      defaultScopeFor(scope);
    switch (action) {
      case "home":
        return dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" });
      case "create-workspace":
        return addProject.openDispatcher();
      case "settings":
        return dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
      case "customize":
        return dispatch({ type: "SET_ACTIVE_PAGE", page: "customize" });
      case "shortcuts":
        return onShowShortcuts();
      case "feedback":
        return requestFeedbackDialog();
      case "open-folder":
        return addProject.openProject();
      case "clone-repository":
        return addProject.openGithubProject();
      case "quick-start":
        return addProject.quickStart();
      case "new-chat":
        return folder && spawnNewChatTab({ folder, sessions, dispatch });
      case "new-terminal-agent":
        return folder && spawnTerminalTab({ folder, dispatch });
      case "new-terminal": {
        if (!folder) return;
        const terminal = useTerminalStore.getState().createSession(folder);
        dispatch({
          type: "OPEN_WORKBENCH_TERMINAL",
          scope,
          terminalId: terminal.id,
          title: terminal.title,
          placement: "tab",
        });
        return revealWorkbench();
      }
      case "files":
      case "changes":
      case "review": {
        const existing = workbench.tabs.find(
          (tab) => tab.type === action && (action !== "files" || tab.fixed),
        );
        if (existing)
          dispatch({
            type: "OPEN_WORKBENCH_TAB",
            scope,
            id: existing.id,
            ...(action === "files"
              ? { updates: { fileTreeVisible: true } }
              : {}),
          });
        else
          dispatch({
            type: "ADD_WORKBENCH_TAB",
            scope,
            tab:
              action === "files"
                ? createEmptyFilesTab()
                : action === "changes"
                  ? createChangesTab()
                  : createReviewTab(),
          });
        return revealWorkbench();
      }
      case "browser":
        return openBrowser();
      case "copy-file-path": {
        const path = workbench.tabs.find(
          (tab) => tab.id === workbench.activeId,
        )?.filePath;
        if (!path) return;
        return copyToClipboardWithFallback(path).then((copied) => {
          if (!copied && current()) toast.error("Couldn't copy the file path");
        });
      }
      case "reveal-folder":
        return folder && revealInFinder(folder);
      case "toggle-sidebar":
        return toggleSidebarCollapsed();
      case "toggle-workbench":
        return toggleWorkbench();
    }
  };

  const select = (selected: PaletteEntry): boolean => {
    if (!current()) return false;
    const entry = entries.find((row) => row.id === selected.id);
    if (!entry) return false;
    // Recheck mutable gates at the event boundary, including a VM stopped or
    // an archive started between the last render and the key/click event.
    const latestWorkspace =
      ownedActive &&
      (peekWorkspacesFor(ownedActive.repoSlug)?.find(
        (row) => row.id === ownedActive.id,
      ) ??
        ownedActive);
    const currentCapabilities = paletteCapabilities({
      ...capabilityInput,
      workspace: latestWorkspace,
      loading:
        active.loading ||
        !!(
          ownedActive &&
          ownedActive.id in usePendingWorkspacesStore.getState().archiveIntents
        ),
      cloudCanEdit: cloudWorkspaceCanEdit(active.folder ?? undefined),
      cloudStatus: cloudTarget
        ? cloudWorkspaceDocument(cloudTarget)?.status
        : undefined,
      terminalAgents: isExperimentalEnabled("terminalAgents"),
    });
    const target = entry.target;
    if (
      target.type === "action" &&
      !actionPaletteEntries(currentCapabilities).some(
        (row) => row.id === entry.id,
      )
    )
      return false;
    if (
      target.type === "file" &&
      (!currentCapabilities.workspace || target.folder !== active.folder)
    )
      return false;
    if (
      target.type === "settings" &&
      !settingsPaletteEntries({
        ...settingsAvailability,
        terminalAgentsEnabled: isExperimentalEnabled("terminalAgents"),
        computerUseActive: isAgentControlFeatureActive("computerUse"),
        simulatorsActive: isAgentControlFeatureActive("simulators"),
      }).some((row) => row.id === entry.id)
    )
      return false;
    const run = (): unknown => {
      switch (target.type) {
        case "workspace":
          return openWorkspace(target.workspace);
        case "chat": {
          const chat = useWorkspaceStore
            .getState()
            .chats.find(
              (row) =>
                row.id === target.chatId &&
                !row.archived &&
                row.folder === target.folder,
            );
          if (!chat) return;
          prepareChatView(chat.id);
          void sessions.hydrateChat(chat.id);
          dispatch({
            type: "OPEN_WORKSPACE",
            folder: target.folder,
            repoRoot: target.workspace.repoRoot,
            chatId: chat.id,
          });
          const cloud = parseCloudWorkspaceKey(target.folder);
          if (
            cloud &&
            !workspaceIsReadOnly(target.workspace) &&
            hasCloudWorkspaceAccountAccess(cloud.organizationId)
          )
            requestCloudWorkspaceOpen(target.folder);
          return;
        }
        case "file": {
          const scope = workbenchScopeForFolder(target.folder);
          const state =
            useWorkspaceStore.getState().workbenchByScope[scope] ??
            defaultScopeFor(scope);
          dispatch(
            buildDirectFileOpenAction(state.tabs, target.path, {
              scope,
              literalPath: true,
              preferredExistingTabId: state.activeId,
            }),
          );
          return revealWorkbench();
        }
        case "action":
          return runAction(target.action);
        case "settings":
          requestUserSettingsSection(target.section);
          return dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
        case "theme":
          return setPrefs({ mode: target.mode });
      }
    };
    try {
      void Promise.resolve(run()).catch(() => {
        if (current())
          toast.error("Couldn't complete that command. Please try again.");
      });
      return true;
    } catch {
      toast.error("Couldn't complete that command. Please try again.");
      return false;
    }
  };

  let notice: string | undefined;
  let retry: (() => void) | undefined;
  if (category === "files" && !capabilities.workspace)
    notice = "Open an available workspace to search its files.";
  else if (filesEnabled && files.error) {
    notice = files.files.length
      ? "Couldn't refresh files. Showing the last available list."
      : "Couldn't load files.";
    retry = files.retry;
  } else if (
    category === "workspaces" &&
    workspaceFilter !== "active" &&
    archives.error
  ) {
    notice = "Couldn't refresh archived workspaces.";
    retry = archives.refresh;
  }
  return (
    <CommandPalette
      entries={entries}
      query={query}
      onQueryChange={setQuery}
      category={category}
      onCategoryChange={setCategory}
      workspaceFilter={workspaceFilter}
      onWorkspaceFilterChange={setWorkspaceFilter}
      loading={
        category === "files" ? files.loading : live.loading || archives.loading
      }
      notice={notice}
      onRetry={retry}
      onDismiss={onDismiss}
      onSelect={select}
      onIntent={(entry) => {
        if (!current()) return;
        if (entry.target.type === "workspace" || entry.target.type === "chat")
          prefetchWorkspaceSurface(entry.target.workspace);
        if (entry.target.type === "chat") prepareChatView(entry.target.chatId);
      }}
    />
  );
}
