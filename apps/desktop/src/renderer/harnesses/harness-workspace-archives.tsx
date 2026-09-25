// Development-only fixture: real Dashboard and Settings, synthetic transport.
// Dashboard stays mounted across navigation, matching the retained app shell.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import React from "react";
import { createRoot } from "react-dom/client";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import type { Workspace } from "../platform/git";
import type { SessionsActions } from "../features/agent/sessions-context";
import type { AuthContextValue } from "../features/auth/auth-context";

const epochKey = "fixture:archive-epoch";
if (!sessionStorage.getItem(epochKey)) {
  localStorage.clear();
  sessionStorage.setItem(epochKey, String(Date.now()));
}
const now = Number(sessionStorage.getItem(epochKey));
const repo = {
  id: "example",
  name: "Example",
  repoRoot: "/fixture/example",
  repoSlug: "example",
  originUrl: null,
  addedAt: 1,
};
localStorage.setItem("zeros-projects-v1", JSON.stringify([repo]));
localStorage.setItem("zeros:dashboard-show-archived", "1");
let rows: Workspace[] = [
  { id: "recent", branch: "example/Recent", age: 2 },
  { id: "older", branch: "example/Older", age: 16 },
].map((owner) => ({
  id: owner.id,
  branch: owner.branch,
  repoRoot: repo.repoRoot,
  repoSlug: repo.repoSlug,
  path: `/Users/dev/zeros/workspaces/example/${owner.id}`,
  baseBranch: "main",
  status: "in-progress",
  createdAt: 1,
  archivedAt: now - owner.age * 86400000,
  stashRef: null,
  archiveSnapshot: "a".repeat(40),
  prNumber: null,
  prState: null,
  prUrl: null,
  agentId: null,
  lastActiveAt: null,
  present: false,
}));
rows.push(
  ...[
    ["snapshot", "Saved snapshot"],
    ["locate", "Moved folder"],
    ["none", "No recovery"],
  ].map(([id, branch]) => ({
    ...rows[0]!,
    id,
    branch,
    archivedAt: null,
    path: `/Users/dev/zeros/workspaces/example/${id}`,
  })),
);
let selectedFolder: string | null = null;
Object.assign(window, {
  __ZEROS_NATIVE__: {
    invoke: async (command: string) =>
      command === "dialog_pick_folder" ? selectedFolder : null,
    on: () => () => {},
  },
});
const { setActiveBridge } = await import("../platform/bridge/active-bridge");
const requests: { op: string; params?: Record<string, unknown> }[] = [];
const archiveFlights = new Map<string, (fail: boolean) => void>();
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
        workspaces: rows.filter((owner) =>
          message.params?.archived === true
            ? owner.archivedAt != null
            : owner.archivedAt == null,
        ),
      };
    if (message.op === "messages.windowOlder") result = { messages: [] };
    if (message.op === "workspace.recoveryInfo")
      result = {
        action:
          message.params?.workspaceId === "snapshot"
            ? "restore"
            : message.params?.workspaceId === "locate"
              ? "locate"
              : "none",
        snapshotAt: message.params?.workspaceId === "snapshot" ? now : null,
      };
    if (message.op === "project.list") result = { projects: [repo] };
    if (message.op === "workspace.get")
      result = rows.find((owner) => owner.id === message.params?.workspaceId);
    if (message.op === "workspace.archive") {
      const id = String(message.params?.workspaceId);
      result = await new Promise((resolve, reject) => {
        archiveFlights.set(id, (fail) => {
          archiveFlights.delete(id);
          if (fail) {
            reject(new Error("Fixture checkpoint failure"));
            return;
          }
          const original = rows.find((owner) => owner.id === id)!;
          const workspace = {
            ...original,
            archivedAt: Date.now(),
            present: false,
          };
          rows = rows.map((owner) => (owner.id === id ? workspace : owner));
          resolve({
            workspace,
            archivedAt: workspace.archivedAt,
            stashRef: null,
          });
        });
      });
    }
    if (
      message.op === "workspace.restore" ||
      message.op === "workspace.recover" ||
      message.op === "workspace.locate" ||
      message.op === "workspace.deleteSnapshot"
    ) {
      const original = rows.find(
        (owner) => owner.id === message.params?.workspaceId,
      )!;
      const restored = message.op !== "workspace.deleteSnapshot";
      if (
        message.op === "workspace.locate" &&
        message.params?.path === "/fixture/wrong"
      )
        throw new Error(
          "Select the original workspace folder. The selected folder was not changed.",
        );
      const workspace = restored
        ? {
            ...original,
            archivedAt: null,
            present: true,
            ...(message.op === "workspace.locate"
              ? { path: String(message.params?.path) }
              : {}),
          }
        : { ...original, archiveSnapshot: null };
      rows = rows.map((owner) =>
        owner.id === workspace.id ? workspace : owner,
      );
      result = restored
        ? {
            workspace,
            restoredAt: Date.now(),
            path: workspace.path,
            branch: workspace.branch,
            conflicts: message.op === "workspace.recover" ? ["README.md"] : [],
            adaptations:
              message.op === "workspace.recover"
                ? ["Restored to an available branch because the original branch is in use."]
                : message.op === "workspace.locate"
                  ? ["Reconnected the original workspace at its new location."]
                  : [],
          }
        : workspace;
    }
    return { type: "WORKSPACE_RESPONSE", result };
  },
} as unknown as RuntimeClient);
const { useWorkspaceStore } = await import("../state/store");
const chats = rows.map((row) => ({
  id: `${row.id}-chat`,
  title: row.branch.replace("example/", ""),
  folder: row.path,
  agentId: "fixture-agent",
  agentName: "Fixture agent",
  model: "",
  effort: "medium" as const,
  permissionMode: "auto" as const,
  createdAt: 1,
  updatedAt: 1,
}));
const activeReference = new URLSearchParams(location.search).has(
  "active-chat-reference",
);
if (activeReference) rows[0] = { ...rows[0]!, present: true, archivedAt: null };
useWorkspaceStore.setState({
  activePage: activeReference ? "workspace" : "dashboard",
  activeChatId: activeReference ? "recent-chat" : null,
  chats,
});
Object.assign(window, {
  archiveFixture: {
    requests,
    snapshot: () => useWorkspaceStore.getState(),
    seedHistoryEdge: (kind: "empty" | "terminal" | "unbound" | "closed") => {
      const owner = rows.find((row) => row.id === "none")!;
      const id = `edge-${kind}`;
      const chat = {
        ...chats.find((row) => row.id === "none-chat")!,
        id,
        title: "Saved edge conversation",
        agentId: kind === "unbound" ? null : "fixture-agent",
        kind: kind === "terminal" ? ("terminal" as const) : ("chat" as const),
        archived: kind === "closed",
      };
      useWorkspaceStore.setState((state) => ({
        chats: [
          ...state.chats.filter((row) => row.folder !== owner.path),
          ...(kind === "empty" ? [] : [chat]),
        ],
      }));
      useWorkspaceStore.getState().dispatch({
        type: "OPEN_WORKSPACE",
        folder: owner.path,
        repoRoot: owner.repoRoot,
        chatId: kind === "unbound" ? id : null,
      });
    },
    selectFolder: (path: string | null) => {
      selectedFolder = path;
    },
    archivePending: (id: string) => archiveFlights.has(id),
    finishArchive: (id: string, fail = false) => archiveFlights.get(id)?.(fail),
    seedPendingHistory: () => {
      const original = chats.find((chat) => chat.id === "recent-chat")!;
      useWorkspaceStore.setState({
        chats: [
          ...chats,
          { ...original, id: "recent-other", title: "Untitled", createdAt: 2 },
          {
            ...original,
            id: "recent-closed",
            title: "Closed chat",
            archived: true,
            createdAt: 3,
          },
        ],
        chatComposerDrafts: {
          "recent-chat": { text: "Keep my unsent draft", attachments: [] },
          "recent-other": { text: "Keep my other draft", attachments: [] },
        },
        pendingAutoSend: { "recent-chat": now, "recent-other": now },
        pendingChatSubmission: {
          id: "history-pending-send",
          text: "Do not send from history",
          source: "manual",
        },
        pendingComposerAppend: {
          id: "history-pending-append",
          chatId: "recent-chat",
          text: "Do not consume from history",
          source: "manual",
        },
      });
    },
    navigate: (activePage: "dashboard" | "settings" | "repo") =>
      useWorkspaceStore.setState({ activePage }),
  },
});
const { ConversationPane } =
  await import("../shell/conversation/conversation-pane");
const { AddProjectProvider } = await import("../shell/add-project-provider");
const { TopBar } = await import("../shell/top-bar");
const { useActiveWorkspace } = await import("../state/use-active-workspace");
const { workspaceIsReadOnly } = await import("../state/workspace-history");
const { RepoWorkspacesList } =
  await import("../features/repositories/repo-page");
const { useSessionsStore, BLANK } =
  await import("../features/agent/sessions-store");
const { DashboardPage } = await import("../features/dashboard/dashboard-page");
const { SettingsPage } = await import("../features/settings/settings-page");
const { TooltipProvider } = await import("../shared/ui/primitives/tooltip");
const { Toaster } = await import("../shared/ui/primitives/elements/toast");
const { Button } = await import("../shared/ui/primitives/button");
const { ActionsCtx } = await import("../features/agent/sessions-context");
const { AuthContext } = await import("../features/auth/auth-context");
const sessions = {
  getSession: (id: string) => useSessionsStore.getState().sessions[id],
  hydrateChat: async (id: string) => {
    if (useSessionsStore.getState().sessions[id]) return;
    useSessionsStore.getState().setSession(id, {
      ...BLANK,
      transcriptState: "resident",
      messages: [
        {
          id: `${id}-prompt`,
          kind: "text",
          role: "user",
          text: "Keep this conversation available",
          createdAt: now,
        },
        {
          id: `${id}-thinking`,
          kind: "text",
          role: "thought",
          text: "Checking the saved conversation.",
          createdAt: now + 500,
        },
        {
          id: `${id}-reply`,
          kind: "text",
          role: "agent",
          text:
            id === "recent-other"
              ? "A separate saved conversation."
              : id === "recent-closed"
                ? "Saved conversation from a closed tab."
                : [
                    "Your saved conversation remains readable here.",
                    "Paragraph spacing matches the active conversation.",
                    "### Saved details",
                    "- Read the saved messages\n- Keep their formatting",
                    "Use `saved content` without changing the workspace.",
                    "> Recorded output stays readable.",
                    "| Content | State |\n| --- | --- |\n| Chat | Saved |",
                  ].join("\n\n"),
          createdAt: now + 1000,
        },
      ],
    });
  },
  ensureSession: async () => {
    requests.push({ op: "fixture.ensureSession" });
  },
  sendPrompt: async () => {
    requests.push({ op: "fixture.sendPrompt" });
  },
  releaseQueue: () => {
    requests.push({ op: "fixture.releaseQueue" });
  },
  getCloseActivity: () => ({ running: false, queuedCount: 0 }),
  setRetainedChatIds: () => {},
  loadIntoChat: async () => {
    requests.push({ op: "fixture.loadIntoChat" });
    return true;
  },
} as unknown as SessionsActions;
const auth: AuthContextValue = {
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
};

/** Both reference and history use the actual conversation pane, tabs, retained
 * deck and ChatView. Only the workspace lifecycle differs. */
function ActiveTranscriptReference() {
  return (
    <div className="bg-bg1 text-fg1 flex h-screen flex-col">
      <ConversationPane workspace={rows[0]} />
    </div>
  );
}

function HistoryRoute() {
  const { workspace } = useActiveWorkspace();
  return (
    <>
      <TopBar />
      {workspace && !workspaceIsReadOnly(workspace) && (
        <div data-testid="restored-workspace">Workspace ready</div>
      )}
      {workspace && <ConversationPane workspace={workspace} />}
    </>
  );
}

function Harness() {
  const activePage = useWorkspaceStore((state) => state.activePage);
  return (
    <AuthContext.Provider value={auth}>
      <ActionsCtx.Provider value={sessions}>
        <TooltipProvider>
          <AddProjectProvider>
            {activeReference ? (
              <ActiveTranscriptReference />
            ) : (
              <main className="bg-bg1 text-fg1 flex h-screen flex-col">
                <nav className="flex gap-2 p-2" aria-label="Fixture navigation">
                  <Button
                    onClick={() =>
                      useWorkspaceStore.setState({ activePage: "dashboard" })
                    }
                  >
                    Dashboard fixture
                  </Button>
                  <Button
                    onClick={() =>
                      useWorkspaceStore.setState({ activePage: "settings" })
                    }
                  >
                    Settings fixture
                  </Button>
                </nav>
                <div
                  className={
                    activePage === "dashboard"
                      ? "flex min-h-0 flex-1 flex-col"
                      : "hidden"
                  }
                >
                  <DashboardPage />
                </div>
                {activePage === "settings" && <SettingsPage />}
                {activePage === "repo" && <RepoWorkspacesList project={repo} />}
                {activePage === "workspace" && <HistoryRoute />}
              </main>
            )}
            <Toaster />
          </AddProjectProvider>
        </TooltipProvider>
      </ActionsCtx.Provider>
    </AuthContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
