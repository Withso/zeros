// Real app sidebar, Home pages, Create page and navigation store; synthetic
// transport. Four repositories with live workspaces exercise Grouped and
// Ungrouped lists, repository actions, collapse, Create from… and archive.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { createRoot } from "react-dom/client";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import type { Workspace } from "../platform/git";
import type { SessionsActions } from "../features/agent/sessions-context";
import type { AuthContextValue } from "../features/auth/auth-context";
import type { ChatThread } from "../state/store";
import type { Project } from "../state/projects-store";
import type { ProcessMetricsSnapshot } from "../platform/process-metrics";

const params = new URLSearchParams(location.search);
if (!sessionStorage.getItem("fixture:app-sidebar")) {
  localStorage.clear();
  sessionStorage.setItem("fixture:app-sidebar", "1");
}
const legacyFilter = params.get("filter");
if (legacyFilter) {
  localStorage.setItem(
    "zeros:ui-state:v1",
    JSON.stringify({
      activePage: "dashboard",
      workspaceListFilter: legacyFilter,
    }),
  );
}

const projects: Project[] = [
  ["zeros", "Zeros"],
  ["ocolors", "0colors"],
  ["okit", "0kit"],
  ["todo-app", "To-do app"],
].map(([slug, name], index) => ({
  id: `project-${slug}`,
  name,
  repoRoot: `/fixture/${slug}`,
  repoSlug: slug,
  originUrl: `https://github.com/example/${slug}.git`,
  isGitRepository: true,
  addedAt: index + 1,
}));
if (params.has("unopened-folder")) {
  projects.push({
    id: "project-empty-folder",
    name: "Empty folder",
    repoRoot: "/fixture/empty-folder",
    repoSlug: "empty-folder",
    originUrl: null,
    isGitRepository: false,
    addedAt: 6,
  });
}
if (!localStorage.getItem("zeros-projects-v1")) {
  localStorage.setItem("zeros-projects-v1", JSON.stringify(projects));
}

const rows: Workspace[] = [
  ["zeros", "atlanta", 3],
  ["zeros", "boston", 4],
  ["ocolors", "seville", 2],
  ["okit", "paris-mumbai-city-docs", 5],
  ["todo-app", "new-york", 1],
].map(([slug, name, created]) => ({
  id: `ws-${name}`,
  repoSlug: String(slug),
  repoRoot: `/fixture/${slug}`,
  branch: `zeros/${name}`,
  baseBranch: "main",
  path: `/fixture-workspaces/${slug}/${name}`,
  status: "in-progress",
  createdAt: Number(created),
  archivedAt: null,
  stashRef: null,
  prNumber: null,
  prState: null,
  prUrl: null,
  agentId: null,
  lastActiveAt: null,
}));
if (params.has("long-list")) {
  rows.push(
    ...Array.from({ length: 30 }, (_, index) => ({
      ...rows[0],
      id: `ws-extra-${index}`,
      path: `/fixture-workspaces/zeros/extra-${index}`,
      branch: `zeros/extra-${index}`,
      createdAt: 20 + index,
    })),
  );
}
const changeLines: Record<string, { additions: number; deletions: number }> = {
  "ws-paris-mumbai-city-docs": { additions: 87, deletions: 0 },
  "ws-atlanta": { additions: 12, deletions: 3 },
};
const runningIds = new Set(["ws-boston"]);
const requests: { op: string; params?: Record<string, unknown> }[] = [];
let deferChangeLines = false;
const pendingChangeLines: (() => void)[] = [];
const resourceTotals = {
  cpuPercent: 4,
  memoryBytes: 1.2 * 1024 ** 3,
  peakCpuPercent: 10,
  peakCpuAt: 1,
  peakMemoryBytes: 1.2 * 1024 ** 3,
  peakMemoryAt: 1,
  processCount: 4,
};
const resourceSnapshot: ProcessMetricsSnapshot = {
  sampledAt: 1,
  samplingIntervalMs: 1_000,
  scanDurationMs: 1,
  cpuReady: true,
  logicalCpuCount: 8,
  systemMemoryBytes: 16 * 1024 ** 3,
  terminalRootsKnown: true,
  totals: { all: resourceTotals, excludingTerminals: resourceTotals },
  processes: [],
};
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
localStorage.setItem(
  "zeros.agent.registrySnapshot",
  JSON.stringify({ agents, at: Date.now() }),
);

Object.assign(window, {
  appSidebarRequests: requests,
  __ZEROS_NATIVE__: {
    on: () => () => {},
    invoke: async (op: string, invokeParams?: Record<string, unknown>) => {
      requests.push({ op, params: invokeParams });
      if (op === "process_metrics_snapshot") return resourceSnapshot;
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
    if (message.op === "workspace.list") {
      const slug = message.params?.repoSlug;
      result = {
        workspaces:
          message.params?.archived === true
            ? []
            : rows.filter((row) => !slug || row.repoSlug === slug),
      };
    }
    if (message.op === "git.changeLineCounts") {
      result = changeLines[String(message.params?.workspaceId)] ?? {
        additions: 0,
        deletions: 0,
      };
      if (deferChangeLines) {
        await new Promise<void>((resolve) => pendingChangeLines.push(resolve));
      }
    }
    if (message.op === "workspace.runInfo")
      result = {
        actions: runningIds.has(String(message.params?.workspaceId))
          ? { dev: { state: "running" } }
          : {},
      };
    if (message.op === "settings.resolve")
      result = { effective: {}, sources: {}, warnings: [] };
    if (message.op === "settings.read")
      result = { doc: {}, text: "", exists: false };
    if (message.op === "git.listAllBranches")
      result = ["main", "feature/local"].map((name) => ({
        name,
        tipSha: "fixture-sha",
        lastCommitDate: 1,
        origin: "unknown",
        isCheckedOut: name === "main",
        worktreePath: null,
        prUrl: null,
      }));
    if (message.op === "git.repoBranchCatalog")
      result = {
        remotes: [],
        effectiveRemote: "origin",
        remoteExists: false,
        baseExplicit: false,
        effectiveBase: "main",
        detectedDefault: null,
        listedRemote: null,
        branchSource: "local",
        branches: [{ name: "main", lastCommitDate: 1 }],
      };
    return { type: "WORKSPACE_RESPONSE", result };
  },
} as unknown as RuntimeClient);

const { useWorkspaceStore } = await import("../state/store");
const { AppSidebar } = await import("../shell/app-sidebar");
const { useSidebarCollapsed } = await import("../shell/sidebar-collapsed");
const { CollapsedSidebarControls } = await import("../shell/sidebar-toggle");
const { useActiveWorkspace } = await import("../state/use-active-workspace");
const { useSessionsStore, BLANK } =
  await import("../features/agent/sessions-store");
// The real conversation column is opt-in (?conversation): it mounts the full
// transcript + composer tree, which the navigation checks do not need.
const ConversationPane = params.has("conversation")
  ? (await import("../shell/conversation/conversation-pane")).ConversationPane
  : null;
const { DispatcherPage } = await import("../shell/dispatcher/dispatcher-modal");
const { RepoPage } = await import("../features/repositories/repo-page");
const { DashboardPage } = await import("../features/dashboard/dashboard-page");
const { useProjects } = await import("../state/use-projects");
const { AddProjectProvider, useAddProject } =
  await import("../shell/add-project-provider");
const { ActionsCtx } = await import("../features/agent/sessions-context");
const { AuthContext } = await import("../features/auth/auth-context");
const { TooltipProvider } = await import("../shared/ui/primitives/tooltip");
const { Toaster } = await import("sonner");
const { setHomeSidebarWidth } = await import("../shell/home-sidebar-width");
const { triggerGitRefresh } = await import("../shell/use-git-refresh-key");

// One saved chat per workspace, so opening a row restores a chat instead of
// spawning one through the (absent) agent runtime.
const chats = rows.map(
  (row) =>
    ({
      id: `chat-${row.id}`,
      folder: row.path,
      agentId: "claude",
      agentName: "Claude",
      model: null,
      effort: "high",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
    }) as unknown as ChatThread,
);
const saved = useWorkspaceStore.getState();
if (saved.chats.length === 0) {
  useWorkspaceStore.setState({ chats });
}

const sessions = {
  listAgents: async () => agents,
  getSession: (id: string) => useSessionsStore.getState().sessions[id],
  hydrateChat: async (id: string) => {
    if (!ConversationPane || useSessionsStore.getState().sessions[id]) return;
    useSessionsStore.getState().setSession(id, {
      ...BLANK,
      transcriptState: "resident",
      messages: [
        {
          id: `${id}-prompt`,
          kind: "text",
          role: "user",
          text: "Move the workspace navigation into a sidebar.",
          createdAt: 1,
        },
        {
          id: `${id}-reply`,
          kind: "text",
          role: "agent",
          text: [
            "The sidebar now lists every workspace under its repository.",
            "The transcript and the composer share one centred column.",
          ].join("\n\n"),
          createdAt: 2,
        },
      ],
    });
  },
  ensureSession: async () => {},
  sendPrompt: async () => {},
  releaseQueue: () => {},
  setRetainedChatIds: () => {},
  loadIntoChat: async () => true,
  getCloseActivity: () => ({ running: false, queuedCount: 0 }),
} as unknown as SessionsActions;
const auth = {
  status: "unauthenticated",
  session: null,
  userId: null,
  email: null,
  startBrowserSignIn: async () => ({ ok: false }),
  oauthError: null,
  clearOAuthError() {},
  cancelPendingOAuth() {},
  signOut: async () => {},
  signOutEverywhere: async () => {},
} as AuthContextValue;

Object.assign(window, {
  appSidebarSetWidth: setHomeSidebarWidth,
  appSidebarNavigate: (page: "customize" | "settings" | "dashboard") =>
    useWorkspaceStore.getState().dispatch({ type: "SET_ACTIVE_PAGE", page }),
  appSidebarSetChangeLines: (
    id: string,
    counts: { additions: number; deletions: number },
  ) => {
    changeLines[id] = counts;
    triggerGitRefresh(rows.find((row) => row.id === id)?.path);
  },
  appSidebarDeferChangeLines: () => {
    deferChangeLines = true;
  },
  appSidebarReleaseChangeLines: () => {
    deferChangeLines = false;
    for (const resolve of pendingChangeLines.splice(0)) resolve();
  },
  appSidebarState: () => {
    const state = useWorkspaceStore.getState();
    return {
      page: state.activePage,
      repoId: state.activeRepoId,
      createProjectId: state.createWorkspaceProjectId,
      filter: state.workspaceListFilter,
      folder: state.lastWorkspaceFolder,
      repoView: state.activeRepoId
        ? state.repoPageViewByProject[state.activeRepoId]
        : undefined,
      chats: state.chats.map((chat) => ({ id: chat.id, folder: chat.folder })),
    };
  },
});

function Harness() {
  const { openProject, openGithubProject, quickStart } = useAddProject();
  const { projects: registered } = useProjects();
  const page = useWorkspaceStore((state) => state.activePage);
  const activeRepoId = useWorkspaceStore((state) => state.activeRepoId);
  const createProjectId = useWorkspaceStore(
    (state) => state.createWorkspaceProjectId,
  );
  const folder = useWorkspaceStore((state) => state.lastWorkspaceFolder);
  const repoProject = registered.find((row) => row.id === activeRepoId);
  const { workspace: activeWorkspace } = useActiveWorkspace();
  // Mirrors MainShellBody: collapse hides the sidebar, floats its controls
  // over the content's corner, and the corner's owner keeps them clear.
  const collapsed = useSidebarCollapsed();
  const controlsVisible = collapsed && page !== "settings";
  return (
    <div className="bg-bg1 text-fg1 fixed inset-0 flex overflow-hidden font-sans text-sm">
      <Toaster />
      <AppSidebar hidden={page === "settings" || collapsed} />
      <main
        className={[
          "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          // The real chat strip reserves the corner itself.
          controlsVisible && !(page === "workspace" && ConversationPane)
            ? "mt-10"
            : "",
        ].join(" ")}
        data-harness-page={page}
      >
        {page === "create" ? (
          <DispatcherPage
            active
            initialProjectId={createProjectId}
            onOpenProject={openProject}
            onOpenGithubProject={openGithubProject}
            onQuickStart={quickStart}
          />
        ) : page === "repo" && repoProject ? (
          <RepoPage project={repoProject} />
        ) : page === "dashboard" ? (
          <DashboardPage />
        ) : page === "workspace" && ConversationPane ? (
          <div className="flex min-h-0 min-w-0 flex-1">
            <ConversationPane
              workspace={activeWorkspace}
              workbenchCollapsed
              windowControlsInset={collapsed}
            />
          </div>
        ) : page === "workspace" ? (
          <>
            <div className="border-border1 flex h-10 shrink-0 items-center border-b px-3 text-xs">
              Chat · {folder}
            </div>
            <div className="text-fg2 p-6">Workspace {folder}</div>
          </>
        ) : (
          <div className="p-6">{page}</div>
        )}
      </main>
      {controlsVisible && <CollapsedSidebarControls />}
    </div>
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
