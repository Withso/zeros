// Real open-folder, navigation, repository list and dashboard; synthetic transport.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import React from "react";
import { createRoot } from "react-dom/client";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import type { SessionsActions } from "../features/agent/sessions-context";
import type { AuthContextValue } from "../features/auth/auth-context";

if (!sessionStorage.getItem("fixture:folder-workspace")) {
  localStorage.clear();
  sessionStorage.setItem("fixture:folder-workspace", "1");
}
const folder = "/fixture/To-do app";
const savedFolder = new URLSearchParams(location.search).has("subdirectory")
  ? `${folder}/packages/app`
  : folder;
const createFixture = new URLSearchParams(location.search).has("create");
const scratchFixture = new URLSearchParams(location.search).has("scratch");
const automatic =
  createFixture || scratchFixture || new URLSearchParams(location.search).has("automatic");
const createdRows: import("../platform/git").Workspace[] = [];
const reservations = new Map<
  string,
  { workspaceId: string; path: string; repoSlug: string; branch: string }
>();
let nextWorkspace = 0;
let preparationFails = false;
let creationFails = false;
let resumeInit: (() => void) | null = null;
let initGate = Promise.resolve();
let sourcePrGate = Promise.resolve();
let releaseSourcePrs: ((error?: string) => void) | undefined;
const agents = [
  {
    id: "claude",
    name: "Claude Code",
    version: "1.0.0",
    description: "",
    distribution: {},
    installed: true,
    authenticated: true,
  },
];
if (createFixture) {
  localStorage.setItem(
    "zeros.agent.registrySnapshot",
    JSON.stringify({ agents, at: Date.now() }),
  );
}
const requests: { op: string; params?: Record<string, unknown> }[] = [];
let inspection = {
  isRepo: false,
  hasCommits: false,
  isWorktree: false,
  originUrl: null as string | null,
  branch: null,
  mainRoot: null,
  sourceTool: "unknown",
};
let inspectionFails = false;
let initializationFails = false;
let files: string[] = [];
let ignoredFiles: string[] = [];
let fileListingFails = false;
let releaseFiles: (() => void) | undefined;
const filesReady = new URLSearchParams(location.search).has("files")
  ? new Promise<void>((resolve) => {
      releaseFiles = resolve;
    })
  : Promise.resolve();
Object.assign(window, {
  folderWorkspaceRequests: requests,
  pauseFolderPrRead: () => {
    sourcePrGate = new Promise<void>((resolve, reject) => {
      releaseSourcePrs = (error) => error ? reject(new Error(error)) : resolve();
    });
  },
  releaseFolderPrRead: (error?: string) => {
    releaseSourcePrs?.(error);
    sourcePrGate = Promise.resolve();
  },
  setFolderPreparationFails: (fail: boolean) => {
    preparationFails = fail;
  },
  setFolderCreationFails: (fail: boolean) => {
    creationFails = fail;
  },
  pauseFolderInitialization: () => {
    initGate = new Promise<void>((resolve) => {
      resumeInit = resolve;
    });
  },
  resumeFolderInitialization: () => resumeInit?.(),
  releaseFolderFiles: () => releaseFiles?.(),
  failFolderInitialization: (fail: boolean) => {
    initializationFails = fail;
  },
  setFolderInspection: (
    isRepo: boolean,
    originUrl: string | null = null,
    fails = false,
    hasCommits = isRepo,
  ) => {
    inspection = { ...inspection, isRepo, originUrl, hasCommits };
    inspectionFails = fails;
  },
  __ZEROS_NATIVE__: {
    on: () => () => {},
    invoke: async (op: string, params?: Record<string, unknown>) => {
      requests.push({ op, params });
      if (op === "pick_project_folder") return folder;
      if (op === "workspace_init_repo") {
        inspection = { ...inspection, isRepo: true, hasCommits: true };
        return { repoRoot: folder, initialSha: "fixture-initial-commit" };
      }
      if (op === "workspace_inspect_folder") {
        if (inspectionFails) throw new Error("Folder temporarily unavailable");
        return inspection;
      }
      return null;
    },
  },
});
const { setActiveBridge } = await import("../platform/bridge/active-bridge");
setActiveBridge({
  status: "connected",
  onStatusChange: () => () => {},
  onMessage: () => () => {},
  on: () => () => {},
  request: async (message: {
    op: string;
    params?: Record<string, unknown>;
  }) => {
    requests.push(message);
    let result: unknown = {};
    if (message.op === "workspace.list")
      result = {
        workspaces: createdRows.filter(
          (row) => row.repoSlug === message.params?.repoSlug,
        ),
      };
    if (message.op === "git.initInPlace") {
      await initGate;
      if (initializationFails) throw new Error("Git initialization failed");
      inspection = { ...inspection, isRepo: true, hasCommits: true };
      result = { repoRoot: folder, branch: "main" };
    }
    if (message.op === "workspace.prepareCreate") {
      if (preparationFails) throw new Error("Workspace preparation failed");
      const workspaceId = `ws_fixture_${++nextWorkspace}`;
      const reservation = {
        workspaceId,
        path: `/fixture/zeros/workspaces/to-do-app/${workspaceId}`,
        repoSlug: "to-do-app",
        branch: `zeros/task-${nextWorkspace}`,
      };
      reservations.set(workspaceId, reservation);
      result = reservation;
    }
    if (message.op === "workspace.create") {
      if (creationFails) throw new Error("Workspace creation failed");
      const reservation = reservations.get(String(message.params?.preparedId))!;
      const row = {
        ...reservation,
        id: reservation.workspaceId,
        repoRoot: folder,
        baseBranch: "main",
        status: "in-progress" as const,
        createdAt: Date.now(),
        archivedAt: null,
        stashRef: null,
        prNumber: null,
        prState: null,
        prUrl: null,
        agentId: null,
        lastActiveAt: null,
      };
      createdRows.push(row);
      result = row;
    }
    if (message.op === "workspace.setupInfo")
      result = { command: null, state: null, log: "" };
    if (message.op === "git.listAllBranches") {
      result = ["main", "feature/local"].map((name) => ({
        name, tipSha: "fixture-sha", lastCommitDate: 1, origin: "unknown",
        isCheckedOut: name === "main", worktreePath: name === "main" ? folder : null, prUrl: null,
      }));
    }
    if (message.op === "git.repoBranchCatalog") {
      const connected = Boolean(inspection.originUrl);
      result = {
        remotes: connected ? [{ name: "origin", url: inspection.originUrl, isGitHub: true }] : [],
        effectiveRemote: "origin", remoteExists: connected, baseExplicit: false,
        effectiveBase: "main", detectedDefault: connected ? "main" : null,
        listedRemote: connected ? "origin" : null, branchSource: connected ? "remote" : "local",
        branches: ["main", connected ? "feature/remote" : "feature/local"].map((name) => ({ name, lastCommitDate: 1 })),
      };
    }
    if (message.op === "gh.prList") {
      await sourcePrGate;
      result = [{ number: 42, title: "Improve the project picker", headBranch: "feature/remote", url: "https://github.com/example/project/pull/42" }];
    }
    if (message.op === "settings.resolve")
      result = { effective: {}, sources: {}, warnings: [] };
    if (message.op === "settings.read")
      result = { doc: {}, text: "", exists: false };
    if (message.op === "file.tree" || message.op === "file.ignored") {
      await filesReady;
      if (fileListingFails) throw new Error("File listing unavailable");
      result =
        message.op === "file.tree"
          ? { files, truncated: false }
          : { entries: ignoredFiles };
    }
    return { type: "WORKSPACE_RESPONSE", result };
  },
} as unknown as RuntimeClient);
const { useWorkspaceStore, selectActiveFolder } =
  await import("../state/store");
const { selectWorkbench } = await import("../state/workspace-store");
const { useProjects } = await import("../state/use-projects");
const { notifyProjectsChanged } = await import("../state/use-projects");
const { upsertProject, loadProjects } = await import("../state/projects-store");
const { setSetting } = await import("../platform/settings");
const { triggerGitRefresh } = await import("../shell/use-git-refresh-key");
Object.assign(window, {
  setFolderFiles: (next: string[], ignored: string[] = [], fails = false) => {
    files = next;
    ignoredFiles = ignored;
    fileListingFails = fails;
    triggerGitRefresh(folder);
  },
  setFolderGitState: (isGitRepository: boolean, originUrl?: string | null) => {
    inspection = {
      ...inspection,
      isRepo: isGitRepository,
      hasCommits: isGitRepository,
      ...(originUrl !== undefined ? { originUrl } : {}),
    };
    const project = upsertProject({
      repoRoot: folder,
      isGitRepository,
      originUrl,
    });
    // Simulate a refreshed remote snapshot, including remote removal. Ordinary
    // project upserts intentionally only fill an unknown origin.
    if (originUrl !== undefined) {
      setSetting(
        "projects-v1",
        loadProjects().map((row) =>
          row.id === project.id ? { ...row, originUrl } : row,
        ),
      );
    }
    notifyProjectsChanged();
  },
  openFolderSettings: (view: "workspaces" | "git" | "files") => {
    const project = upsertProject({ repoRoot: folder });
    useWorkspaceStore
      .getState()
      .dispatch({ type: "OPEN_REPO_PAGE", projectId: project.id, view });
  },
  selectFolderReview: () => {
    const state = useWorkspaceStore.getState();
    const review = selectWorkbench(state).tabs.find(
      (tab) => tab.type === "review",
    );
    if (review)
      state.dispatch({ type: "ACTIVATE_WORKBENCH_TAB", id: review.id });
  },
});
const WorkbenchPane = new URLSearchParams(location.search).has("workbench")
  ? (await import("../shell/workbench/workbench-pane")).WorkbenchPane
  : null;
const SummaryContents = new URLSearchParams(location.search).has("summary")
  ? (await import("../shell/conversation/summary-contents")).SummaryContents
  : null;
const DispatcherPage = createFixture
  ? (await import("../shell/dispatcher/dispatcher-modal")).DispatcherPage
  : null;
const { TopBar } = await import("../shell/top-bar");
const { NoProjectsView } = await import("../shell/no-projects-view");
const { useProjectCapabilitiesRefresh } =
  await import("../shell/use-project-capabilities-refresh");
const { HomeSidebar } = await import("../shell/home-sidebar");
const { RepoPage } = await import("../features/repositories/repo-page");
const { DashboardPage } = await import("../features/dashboard/dashboard-page");
const { AddProjectProvider, useAddProject } =
  await import("../shell/add-project-provider");
const { ActionsCtx } = await import("../features/agent/sessions-context");
const { AuthContext } = await import("../features/auth/auth-context");
const { TooltipProvider } = await import("../shared/ui/primitives/tooltip");
const { Button } = await import("../shared/ui/primitives/button");
const { Toaster } = await import("sonner");
const { useOpenWorkspace } = await import("../state/use-open-workspace");
const { buildLocalMainWorkspace } =
  await import("../state/local-main-workspace");
const sessions = {
  listAgents: async () => agents,
  getSession: () => undefined,
  hydrateChat: async () => {},
  getCloseActivity: () => ({ running: false, queuedCount: 0 }),
} as unknown as SessionsActions;
const auth = {
  status: "unauthenticated",
  session: null,
  userId: null,
  email: null,
} as AuthContextValue;

function Harness() {
  useProjectCapabilitiesRefresh();
  const { openProject } = useAddProject();
  const openSavedWorkspace = useOpenWorkspace();
  const { projects } = useProjects();
  const project = projects.find((row) => row.repoRoot === folder);
  const activeRepoId = useWorkspaceStore((state) => state.activeRepoId);
  const repoProject = projects.find((row) => row.id === activeRepoId);
  const page = useWorkspaceStore((state) => state.activePage);
  const activeFolder = useWorkspaceStore(selectActiveFolder);
  const chats = useWorkspaceStore((state) => state.chats);
  const activeChatId = useWorkspaceStore((state) => state.activeChatId);
  const drafts = useWorkspaceStore((state) => state.chatComposerDrafts);
  const pendingAutoSend = useWorkspaceStore((state) => state.pendingAutoSend);
  const pendingValidation = useWorkspaceStore(
    (state) => state.pendingWorkspaceValidationFolder,
  );
  const dispatch = useWorkspaceStore((state) => state.dispatch);
  return (
    <>
      <Toaster />
      <TopBar />
      <nav className="flex gap-2 p-4">
        <Button
          onClick={
            automatic
              ? openProject
              : () => {
                  // Restore a pre-existing root-bound chat, not a new-project admission.
                  const saved = upsertProject({
                    repoRoot: folder,
                    isGitRepository: inspection.isRepo,
                  });
                  notifyProjectsChanged();
                  openSavedWorkspace({
                    ...buildLocalMainWorkspace(saved),
                    path: savedFolder,
                  });
                }
          }
        >
          {automatic ? "Open folder fixture" : "Restore saved folder"}
        </Button>
        {DispatcherPage && (
          <Button
            onClick={() =>
              dispatch({ type: "OPEN_CREATE_PAGE", projectId: project?.id })
            }
          >
            Show Create
          </Button>
        )}
        <Button
          onClick={() =>
            project &&
            dispatch({ type: "OPEN_REPO_PAGE", projectId: project.id })
          }
        >
          Show folder settings
        </Button>
        <Button
          onClick={() =>
            dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" })
          }
        >
          Show dashboard
        </Button>
      </nav>
      <div className="flex h-[600px]">
        <HomeSidebar />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {scratchFixture && !project ? (
            <NoProjectsView />
          ) : page === "create" && DispatcherPage ? (
            <DispatcherPage
              active
              initialProjectId={project?.id}
              onOpenProject={openProject}
              onOpenGithubProject={() => {}}
              onQuickStart={() => {}}
            />
          ) : page === "repo" && repoProject ? (
            <RepoPage project={repoProject} />
          ) : page === "dashboard" ? (
            <DashboardPage />
          ) : SummaryContents && activeFolder ? (
            <aside aria-label="Workspace summary" className="w-72 p-3">
              <SummaryContents
                folder={activeFolder}
                active
                onNavigate={() => {}}
              />
            </aside>
          ) : WorkbenchPane && activeFolder ? (
            <WorkbenchPane onToggleWorkbench={() => {}} />
          ) : (
            <div className="p-6">Chat workspace: {activeFolder}</div>
          )}
        </main>
      </div>
      <output data-folder-state>
        {JSON.stringify({
          activeFolder,
          chats: chats.map((chat) => ({ id: chat.id, folder: chat.folder })),
          ...(automatic
            ? {
                page,
                activeChatId,
                fullChats: chats,
                drafts,
                pendingAutoSend,
                pendingValidation,
              }
            : {}),
        })}
      </output>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <AuthContext.Provider value={auth}>
    <ActionsCtx.Provider value={sessions}>
      <TooltipProvider>
        <AddProjectProvider>
          <Harness />
        </AddProjectProvider>
      </TooltipProvider>
    </ActionsCtx.Provider>
  </AuthContext.Provider>,
);
