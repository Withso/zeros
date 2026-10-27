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
const hoverCards = params.has("hover-cards");
const legacyMainFolder = params.has("legacy-main")
  ? `/fixture/zeros${params.has("subdirectory") ? "/packages/app" : ""}`
  : null;
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
if (legacyMainFolder) {
  localStorage.setItem(
    "zeros.experimentalFeatures",
    JSON.stringify({ workInLocalMain: true }),
  );
  if (!localStorage.getItem("zeros:ui-state:v1")) {
    localStorage.setItem(
      "zeros:ui-state:v1",
      JSON.stringify({
        activePage: "workspace",
        activeChatId: "chat-legacy-main",
        lastWorkspaceFolder: legacyMainFolder,
        lastWorkspaceByRepoRoot: { "/fixture/zeros": legacyMainFolder },
      }),
    );
  }
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
].map<Workspace>(([slug, name, created]) => ({
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
})).filter((row) => !params.has("no-workspaces") || row.repoSlug !== "zeros");
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
if (params.has("dashboard")) {
  const epoch = Number(sessionStorage.getItem("fixture:dashboard-epoch")) || Date.now();
  sessionStorage.setItem("fixture:dashboard-epoch", String(epoch));
  const statuses = ["backlog", "in-progress", "in-review", "done", "cancelled"] as const;
  rows.forEach((row, index) => {
    rows[index] = { ...row, status: statuses[index % statuses.length], createdAt: epoch - (index + 1) * 86400000,
      lastActiveAt: epoch - (index + 1) * 3600000, present: true,
      ...(index === 2 ? { prNumber: 42, prState: "ready", prUrl: "https://github.com/example/ocolors/pull/42" } : {}) };
  });
  rows.push({ ...rows[0], id: "ws-archived", branch: "zeros/archived", path: "/fixture-workspaces/zeros/archived",
    status: "done", createdAt: epoch - 10 * 86400000, archivedAt: epoch - 3 * 86400000, present: false, archiveSnapshot: "a".repeat(40) });
  rows.push({ ...rows[0], id: "ws-missing", branch: "zeros/missing", path: "/fixture-workspaces/zeros/missing", present: false });
  if (params.has("large-dashboard")) rows.push(...Array.from({ length: 250 }, (_, index) => ({ ...rows[0],
    id: `ws-bulk-${index}`, branch: `zeros/task-${String(index).padStart(3, "0")}`, path: `/fixture-workspaces/zeros/bulk-${index}` })));
}
if (hoverCards) {
  const now = Date.now();
  for (const row of rows) {
    row.createdAt = now - 3_600_000;
    row.lastActiveAt = now - 29 * 60_000;
  }
  Object.assign(rows.find(row => row.id === "ws-boston")!, {
    prNumber: 42, prState: "ready", prUrl: "https://github.com/example/zeros/pull/42",
  });
  Object.assign(rows.find(row => row.id === "ws-seville")!, {
    prNumber: 43, prState: "merged", prUrl: "https://github.com/example/ocolors/pull/43",
  });
  changeLines["ws-atlanta"] = { additions: 2318, deletions: 388 };
  changeLines["ws-boston"] = { additions: 3506, deletions: 839 };
}
const runningIds = new Set(["ws-boston"]);
const requests: { op: string; params?: Record<string, unknown> }[] = [];
let deferChangeLines = false;
const pendingChangeLines: (() => void)[] = [];
let deferDashboardArchives = params.has("defer-dashboard-archives");
let failDashboardArchives = false;
const pendingDashboardArchives: { resolve: () => void; reject: (error: Error) => void }[] = [];
const resourceTotals = params.has("resource-pressure")
  ? {
      cpuPercent: 149.7,
      memoryBytes: 6.1 * 1024 ** 3,
      peakCpuPercent: 238,
      peakCpuAt: 1,
      peakMemoryBytes: 7.3 * 1024 ** 3,
      peakMemoryAt: 1,
      processCount: 9,
    }
  : {
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
  memorySource: "footprint",
  footprintAgeMs: 500,
  system: params.has("resource-pressure")
    ? {
        sampledAt: 1,
        memoryPressure: "warning",
        memoryFreePercent: 11,
        swapUsedBytes: 6 * 1024 ** 3,
        swapTotalBytes: 7 * 1024 ** 3,
        loadAverage: [17.5, 14.3, 11.9],
        thermalState: "nominal",
      }
    : null,
  otherApps: params.has("resource-pressure")
    ? [{ name: "Zeros Alpha", processCount: 4, cpuPercent: 6.4, memoryBytes: 350 * 1024 ** 2 }]
    : [],
  totals: { all: resourceTotals, excludingTerminals: resourceTotals },
  processes: params.has("resource-pressure")
    ? [
        { id: "main", pid: 100, parentPid: null, name: "Main", kind: "main", cpuPercent: 0.3, memoryBytes: 397 * 1024 ** 2, peakCpuPercent: 1, peakMemoryBytes: 397 * 1024 ** 2, terminal: false },
        { id: "renderer", pid: 200, parentPid: null, name: "Renderer", kind: "renderer", cpuPercent: 21, memoryBytes: 1.2 * 1024 ** 3, peakCpuPercent: 155, peakMemoryBytes: 2.1 * 1024 ** 3, terminal: false },
        { id: "engine", pid: 300, parentPid: 100, name: "Engine", kind: "sidecar", cpuPercent: 18, memoryBytes: 430 * 1024 ** 2, peakCpuPercent: 26, peakMemoryBytes: 494 * 1024 ** 2, terminal: false },
        { id: "supervisor", pid: 310, parentPid: 300, name: "Agent supervisor", kind: "helper", cpuPercent: 0, memoryBytes: 9 * 1024 ** 2, peakCpuPercent: 0, peakMemoryBytes: 9 * 1024 ** 2, terminal: false },
        { id: "codex", pid: 320, parentPid: 310, name: "Codex", kind: "agent", cpuPercent: 12, memoryBytes: 94 * 1024 ** 2, peakCpuPercent: 12, peakMemoryBytes: 94 * 1024 ** 2, terminal: false },
        { id: "shell", pid: 330, parentPid: 320, name: "zsh", kind: "process", cpuPercent: 0, memoryBytes: 3 * 1024 ** 2, peakCpuPercent: 0, peakMemoryBytes: 3 * 1024 ** 2, terminal: false },
        { id: "pnpm", pid: 340, parentPid: 330, name: "pnpm typecheck", kind: "process", cpuPercent: 0.4, memoryBytes: 60 * 1024 ** 2, peakCpuPercent: 1, peakMemoryBytes: 60 * 1024 ** 2, terminal: false },
        { id: "tsc", pid: 350, parentPid: 340, name: "tsc", kind: "process", cpuPercent: 98, memoryBytes: 3.9 * 1024 ** 3, peakCpuPercent: 104, peakMemoryBytes: 4.0 * 1024 ** 3, terminal: false },
        { id: "pty", pid: 360, parentPid: 300, name: "Terminal host", kind: "helper", cpuPercent: 0, memoryBytes: 14 * 1024 ** 2, peakCpuPercent: 0, peakMemoryBytes: 14 * 1024 ** 2, terminal: false },
      ]
    : [],
};
if (params.has("resource-pending-cpu")) {
  resourceSnapshot.processes = resourceSnapshot.processes.map((process) =>
    process.id === "tsc" ? { ...process, cpuPercent: 0, cpuSampled: false } : process);
  resourceSnapshot.totals.all = { ...resourceTotals, cpuPercent: 51.7 };
  resourceSnapshot.totals.excludingTerminals = resourceSnapshot.totals.all;
}
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
  appSidebarSeedCloud: async () => {
    const { acceptOrganizationSnapshot } = await import("../features/team/team-store");
    const { setActiveOrganizationSelection } = await import("../features/team/active-team");
    const { controlPlane } = await import("../features/team/control-plane");
    const { acceptCloudWorkspaceDocument, getCloudProjects, getCloudWorkspaceRows } = await import("../state/cloud-workspace-catalog");
    const { notifyProjectsChanged, setWorkspaceRowsForTesting } = await import("../state/use-projects");
    const organizationId = "11111111-1111-4111-8111-111111111111";
    const otherOrganizationId = "44444444-4444-4444-8444-444444444444";
    const organizations = [organizationId, otherOrganizationId].map((id, index) => ({
      id, name: `Organization ${index + 1}`, slug: `organization-${index + 1}`, logo: null, isPersonal: false,
      role: "owner" as const, defaultTeamId: id, workspaceCapabilities: { local: true, cloud: true },
      teamCapabilities: { multiple: false as const, canCreate: false as const },
    }));
    const membership = { user: { id: "55555555-5555-4555-8555-555555555555", email: "fixture@example.test", displayName: "Fixture", staffRole: null }, organizations, teams: organizations };
    controlPlane.me = async () => membership;
    acceptOrganizationSnapshot(membership);
    const fixtures = [
      { id: "22222222-2222-4222-8222-222222222222", organizationId, name: "cloud-one" },
      { id: "33333333-3333-4333-8333-333333333333", organizationId, name: "cloud-two" },
      { id: "66666666-6666-4666-8666-666666666666", organizationId: otherOrganizationId, name: "cloud-other" },
    ];
    for (const fixture of fixtures) acceptCloudWorkspaceDocument({
      ...fixture, teamId: fixture.organizationId, createdBy: membership.user.id, placement: "cloud", status: "stopped", version: 1,
      error: null, createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z", deletedAt: null,
      capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
      repository: { forge: "github.com", owner: "example", name: fixture.name, revision: "refs/heads/main" },
      generation: { number: 1, architecture: "x86_64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "stopped", lastObservedAt: null },
    });
    if (hoverCards) {
      const cloudChats = fixtures.map(fixture => ({
        ...chats[0],
        id: `cloud:${fixture.organizationId}:${fixture.id}:chat`,
        folder: `cloud://${fixture.organizationId}/${fixture.id}`,
        title: `${fixture.name} activity`,
      }));
      useWorkspaceStore.setState(state => ({ chats: [...state.chats, ...cloudChats] }));
      for (const chat of cloudChats) useSessionsStore.getState().setSession(chat.id, {
        ...BLANK, cwd: chat.folder, transcriptState: "resident", messages: [{
          id: `${chat.id}-reply`, kind: "text", role: "agent",
          text: `Saved progress for ${chat.title}.`, createdAt: Date.now() - 60_000,
        }],
      });
    }
    // Mirror the production catalog lifecycle into the shared read cache. The
    // fixture has no authenticated lifecycle controller or live cloud bridge.
    for (const project of getCloudProjects()) {
      setWorkspaceRowsForTesting(project.repoSlug, getCloudWorkspaceRows().filter(row => row.repoSlug === project.repoSlug));
    }
    notifyProjectsChanged();
    setActiveOrganizationSelection(organizationId, false);
    useWorkspaceStore.getState().dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" });
    Object.assign(window, { appSidebarSelectOwner: (id: string | null) => {
      setActiveOrganizationSelection(id, id === null);
      useWorkspaceStore.getState().dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" });
    } });
    return { organizationId, otherOrganizationId, keys: fixtures.map(fixture => `cloud://${fixture.organizationId}/${fixture.id}`),
      projectIds: getCloudProjects().map(project => project.id) };
  },
  appSidebarRequests: requests,
  __ZEROS_NATIVE__: {
    on: () => () => {},
    invoke: async (op: string, invokeParams?: Record<string, unknown>) => {
      requests.push({ op, params: invokeParams });
      if (op === "process_metrics_snapshot") return resourceSnapshot;
      if (op === "process_diagnostics_report")
        return {
          text: "# Zeros diagnostics report\n## Recent app logs (secret-scrubbed JSONL, newest last)\n",
          logCharacters: 120,
        };
      return null;
    },
  },
});

const { setActiveBridge } = await import("../platform/bridge/active-bridge");
const fixtureBridge = {
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
      if (deferDashboardArchives && message.params?.archived === true)
        await new Promise<void>((resolve, reject) => pendingDashboardArchives.push({ resolve, reject }));
      if (failDashboardArchives && message.params?.archived === true)
        throw new Error("Archive list unavailable");
      const slug = message.params?.repoSlug;
      result = {
        workspaces:
          rows.filter((row) => (!slug || row.repoSlug === slug) &&
            (message.params?.archived === true ? row.archivedAt != null : row.archivedAt == null)),
      };
    }
    if (params.has("dashboard") && ["workspace.archive", "workspace.restore", "workspace.setStatus"].includes(message.op)) {
      const index = rows.findIndex(row => row.id === message.params?.workspaceId);
      if (index < 0) throw new Error("Unknown fixture workspace");
      rows[index] = { ...rows[index],
        ...(message.op === "workspace.archive" ? { archivedAt: Date.now(), present: false } :
          message.op === "workspace.restore" ? { archivedAt: null, present: true } : { status: message.params?.status as Workspace["status"] }) };
      result = message.op === "workspace.restore"
        ? { workspace: rows[index], restoredAt: Date.now(), path: rows[index].path, branch: rows[index].branch, conflicts: [], adaptations: [] }
        : { workspace: rows[index], archivedAt: rows[index].archivedAt, stashRef: null };
    }
    if (params.has("dashboard") && message.op === "git.hasChanges") {
      const counts = changeLines[String(message.params?.workspaceId)];
      result = { hasChanges: !!counts && counts.additions + counts.deletions > 0 };
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
    if (hoverCards && message.op === "git.hasChanges") result = { hasChanges: true };
    if (hoverCards && message.op === "workspace.archive") {
      const row = rows.find(row => row.id === message.params?.workspaceId);
      result = { archivedAt: Date.now(), stashRef: null, ...(row ? { workspace: { ...row, archivedAt: Date.now() } } : {}) };
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
} as unknown as RuntimeClient;
setActiveBridge(fixtureBridge);
// PR buttons and Dashboard recovery observe the provider's connection as well
// as the request singleton. Give those scenarios the connected Local transport.
const { BridgeProvider } = await import("../platform/bridge/use-bridge");
const { Fragment } = await import("react");
const withBridge = hoverCards || params.has("dashboard");
const FixtureBridgeProvider = withBridge ? BridgeProvider : Fragment;
if (withBridge) {
  const { RuntimeClient: FixtureRuntimeClient } = await import("../platform/bridge/ws-client");
  FixtureRuntimeClient.prototype.connect = async function () {
    (this as unknown as { setStatus(status: string): void }).setStatus("connected");
  };
  FixtureRuntimeClient.prototype.request = fixtureBridge.request;
}

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
const { useProjects, notifyWorkspacesChanged } = await import("../state/use-projects");
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
      title: hoverCards ? (row.id === "ws-atlanta" ? "Workspace overview and sidebar filters" : `Updates in ${String(row.branch).replace("zeros/", "")}`) : params.has("dashboard") ? ({
        "ws-atlanta": "Refine Home dashboard",
        "ws-boston": "Improve workspace startup",
        "ws-seville": "Add keyboard shortcuts",
        "ws-paris-mumbai-city-docs": "Polish repository icons",
        "ws-new-york": "Update release notes",
        "ws-archived": "Review pull request workflow",
        "ws-missing": "Recover workspace files",
      }[row.id] ?? row.branch.replace("zeros/", "")) : "Chat",
      createdAt: 1,
      updatedAt: hoverCards ? Date.now() - 29 * 60_000 : params.has("dashboard") ? row.lastActiveAt ?? row.createdAt : 1,
      archived: false,
      messages: [],
    }) as unknown as ChatThread,
);
if (legacyMainFolder) {
  chats.push({ ...chats[0], id: "chat-legacy-main", folder: legacyMainFolder });
}
const saved = useWorkspaceStore.getState();
if (saved.chats.length === 0) {
  useWorkspaceStore.setState({ chats });
}
if (hoverCards) {
  for (const chat of chats) useSessionsStore.getState().setSession(chat.id, {
    ...BLANK, cwd: chat.folder, agentId: "claude", sessionId: `execution-${chat.id}`,
    transcriptState: "resident", messages: [{
      id: `${chat.id}-reply`, kind: "text", role: "agent",
      text: "Added filters and verified workspace switching. The latest changes are ready for review.",
      createdAt: chat.updatedAt,
    }],
  });
}

const sessions = {
  listAgents: async () => agents,
  getSession: (id: string) => useSessionsStore.getState().sessions[id],
  hydrateChat: async (id: string) => {
    if (hoverCards) requests.push({ op: "fixture.hydrateChat", params: { chatId: id } });
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
  prepareForSend: () => null,
  sendPrompt: async (chatId: string, text: string) => {
    if (hoverCards) requests.push({ op: "fixture.sendPrompt", params: { chatId, text } });
  },
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

if (params.has("organizations")) {
  const { accountPresentationOwner, bindAccountPresentationOwner } = await import("../platform/account-presentation-cache");
  const { acceptOrganizationSnapshot } = await import("../features/team/team-store");
  const { controlPlane } = await import("../features/team/control-plane");
  const { default: fixture } = await import("../../../../../scripts/__tests__/fixtures/organization-list.json");
  const organizations = fixture as import("../features/team/control-plane").OrganizationSummary[];
  const user = { sub: "navigation-account", email: "navigation@example.test", name: null, provider: "workos" as const };
  const me = { user: { id: user.sub, email: user.email, displayName: null, staffRole: null }, organizations, teams: organizations };
  bindAccountPresentationOwner(accountPresentationOwner("https://api.example.test", user.sub));
  acceptOrganizationSnapshot(me);
  controlPlane.me = async () => me;
  Object.assign(auth, { status: "authenticated", storedUser: user, userId: user.sub, email: user.email });
}

Object.assign(window, {
  dashboardReleaseArchives: (fail = false, keepDeferred = false) => {
    deferDashboardArchives = keepDeferred;
    for (const read of pendingDashboardArchives.splice(0))
      if (fail) read.reject(new Error("Archive list unavailable"));
      else read.resolve();
  },
  dashboardPendingArchiveReads: () => pendingDashboardArchives.length,
  dashboardFailArchives: (fail: boolean) => { failDashboardArchives = fail; },
  dashboardAddPending: async () => {
    const { beginPendingCreate } = await import("../state/pending-workspaces");
    return beginPendingCreate({ repoRoot: projects[0].repoRoot, repoSlug: projects[0].repoSlug, label: "Prepare integration tests" });
  },
  dashboardFinishPending: async (token: string) => {
    const { finishPendingCreate } = await import("../state/pending-workspaces");
    finishPendingCreate(token);
  },
  appSidebarUpdateWorkspace: (id: string, patch: Partial<Workspace>) => {
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) throw new Error("Unknown fixture workspace");
    rows[index] = { ...rows[index], ...patch };
    notifyWorkspacesChanged(rows[index].repoSlug);
  },
  appSidebarRecordActivity: (id: string, at: number) => {
    const row = rows.find(row => row.id === id);
    if (row) useWorkspaceStore.getState().dispatch({ type: "RECORD_WORKSPACE_ACTIVITY", folder: row.path, at });
  },
  appSidebarUpdateChat: (workspaceId: string) =>
    useWorkspaceStore.getState().dispatch({ type: "TOUCH_CHAT", id: `chat-${workspaceId}` }),
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
      chatId: state.activeChatId,
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
    <FixtureBridgeProvider>
    <ActionsCtx.Provider value={sessions}>
      <TooltipProvider>
        <AddProjectProvider>
          <Harness />
        </AddProjectProvider>
      </TooltipProvider>
    </ActionsCtx.Provider>
    </FixtureBridgeProvider>
  </AuthContext.Provider>,
);
