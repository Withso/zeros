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
localStorage.setItem("projects-v1", JSON.stringify([repo]));
localStorage.setItem("zeros:dashboard-show-archived", "1");
let rows: Workspace[] = [
  { id: "recent", branch: "example/Recent", age: 2 },
  { id: "older", branch: "example/Older", age: 16 },
].map((owner) => ({
  id: owner.id,
  branch: owner.branch,
  repoRoot: repo.repoRoot,
  repoSlug: repo.repoSlug,
  path: `/fixture/workspaces/${owner.id}`,
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
Object.assign(window, {
  __ZEROS_NATIVE__: { invoke: async () => null, on: () => () => {} },
});
const { setActiveBridge } = await import("../platform/bridge/active-bridge");
const requests: { op: string; params?: Record<string, unknown> }[] = [];
const archiveFlights = new Map<string, (fail: boolean) => void>();
setActiveBridge({
  status: "connected",
  onStatusChange: () => () => {},
  onMessage: () => () => {},
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
      message.op === "workspace.deleteSnapshot"
    ) {
      const original = rows.find(
        (owner) => owner.id === message.params?.workspaceId,
      )!;
      const restored = message.op === "workspace.restore";
      const workspace = restored
        ? { ...original, archivedAt: null, present: true }
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
            conflicts: [],
            adaptations: [],
          }
        : workspace;
    }
    return { type: "WORKSPACE_RESPONSE", result };
  },
} as unknown as RuntimeClient);
const { useWorkspaceStore } = await import("../state/store");
useWorkspaceStore.setState({ activePage: "dashboard", chats: [] });
Object.assign(window, {
  archiveFixture: {
    requests,
    archivePending: (id: string) => archiveFlights.has(id),
    finishArchive: (id: string, fail = false) => archiveFlights.get(id)?.(fail),
    navigate: (activePage: "dashboard" | "settings") =>
      useWorkspaceStore.setState({ activePage }),
  },
});
const { DashboardPage } = await import("../features/dashboard/dashboard-page");
const { SettingsPage } = await import("../features/settings/settings-page");
const { TooltipProvider } = await import("../shared/ui/primitives/tooltip");
const { Toaster } = await import("../shared/ui/primitives/elements/toast");
const { Button } = await import("../shared/ui/primitives/button");
const { ActionsCtx } = await import("../features/agent/sessions-context");
const { AuthContext } = await import("../features/auth/auth-context");
const sessions = {
  getSession: () => undefined,
  getCloseActivity: () => ({ running: false, queuedCount: 0 }),
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

function Harness() {
  const activePage = useWorkspaceStore((state) => state.activePage);
  return (
    <AuthContext.Provider value={auth}>
      <ActionsCtx.Provider value={sessions}>
        <TooltipProvider>
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
          </main>
          <Toaster />
        </TooltipProvider>
      </ActionsCtx.Provider>
    </AuthContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
