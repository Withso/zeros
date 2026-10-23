// Development-only navigation fixture using the real repository page and store.
// Transport reads are synthetic; no checkout or Design file is modified.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  RepoPage,
  repoPageViewForSection,
} from "../features/repositories/repo-page";
import {
  ActionsCtx,
  type SessionsActions,
} from "../features/agent/sessions-context";
import { BridgeProvider } from "../platform/bridge/use-bridge";
import { RuntimeClient } from "../platform/bridge/ws-client";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import type { BridgeMessage } from "../platform/bridge/messages";
import { Button } from "../shared/ui/primitives/button";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { upsertProject } from "../state/projects-store";
import { useWorkspaceStore } from "../state/workspace-store";
import {
  acceptCloudWorkspaceDocument,
  getCloudProjects,
} from "../state/cloud-workspace-catalog";
import { acceptOrganizationSnapshot } from "../features/team/team-store";
import { setActiveOrganizationSelection } from "../features/team/active-team";
import type { OrganizationSummary } from "../features/team/control-plane";
import { SettingsPage } from "../features/settings/settings-page";
import { writeScopedSettingsSelection } from "../features/settings/settings-scope";
import {
  AuthContext,
  type AuthContextValue,
} from "../features/auth/auth-context";

const organization: OrganizationSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "fixture",
  name: "Fixture organization",
  logo: null,
  role: "owner",
  isPersonal: false,
  defaultTeamId: null,
  workspaceCapabilities: { local: true, cloud: true },
  teamCapabilities: { multiple: false, canCreate: false },
};
acceptOrganizationSnapshot({
  user: {
    id: "fixture",
    email: "fixture@example.test",
    displayName: "Fixture",
    staffRole: null,
  },
  organizations: [organization],
  teams: [organization],
});
// Cloud repository IDs come from the catalog and stay stable across reloads.
acceptCloudWorkspaceDocument({
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: organization.id,
  teamId: organization.id,
  createdBy: organization.id,
  name: "main",
  placement: "cloud",
  status: "stopped",
  version: 1,
  error: null,
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
  deletedAt: null,
  capabilities: {
    canWrite: true,
    canEdit: true,
    canManage: false,
    canStart: true,
    startUnavailableReason: null,
  },
  repository: {
    forge: "github.com",
    owner: "example",
    name: "cloud-settings",
    revision: "refs/heads/main",
  },
  generation: {
    number: 1,
    architecture: "x86_64",
    resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
    observedState: "stopped",
    lastObservedAt: null,
  },
});

const projects = [
  upsertProject({ repoRoot: "/fixture/settings-local", name: "Local" }),
  upsertProject({
    repoRoot: "/fixture/settings-organization",
    name: "Organization local",
  }),
  getCloudProjects()[0],
];

function openProject(projectId: string) {
  const personal = projectId === projects[0].id;
  setActiveOrganizationSelection(personal ? null : organization.id, personal);
  useWorkspaceStore.getState().dispatch({ type: "OPEN_REPO_PAGE", projectId });
}

const requests: string[] = [];
Object.assign(window, {
  repoSettingsRequests: requests,
  repoSettingsProjects: projects,
  openRepoSettingsSection: (section: string) => {
    const state = useWorkspaceStore.getState();
    state.dispatch({
      type: "OPEN_REPO_PAGE",
      projectId: state.activeRepoId!,
      view: repoPageViewForSection(section),
    });
  },
  openLegacyRepoSettingsSection: (section: string) => {
    openProject(projects[0].id);
    writeScopedSettingsSelection(
      "local",
      "section",
      `repo:${projects[0].id}:${section}`,
    );
    useWorkspaceStore
      .getState()
      .dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
  },
});
// This settings-only fixture never invokes agent actions.
const sessions = {} as SessionsActions;
const auth: AuthContextValue = {
  status: "authenticated",
  session: null,
  userId: "fixture",
  email: "fixture@example.test",
  startBrowserSignIn: async () => ({ ok: false }),
  oauthError: null,
  clearOAuthError: () => {},
  cancelPendingOAuth: () => {},
  signOut: async () => {},
  signOutEverywhere: async () => {},
};
const state = useWorkspaceStore.getState();
openProject(
  projects.find((project) => project.id === state.activeRepoId)?.id ??
    projects[0].id,
);

Object.defineProperty(RuntimeClient.prototype, "status", {
  get: () => "connected",
});
RuntimeClient.prototype.connect = () => Promise.resolve();
RuntimeClient.prototype.request = async function <
  T extends BridgeMessage = BridgeMessage,
>(message: Partial<BridgeMessage> & { type: string }): Promise<T> {
  const request = message as {
    op?: string;
    params?: Record<string, unknown>;
    requestId?: string;
  };
  const root = String(
    request.params?.repoRoot ?? request.params?.workspaceId ?? "user",
  );
  if (request.op) requests.push(request.op);
  let result: unknown = {};
  if (request.op === "settings.resolve")
    result = { effective: {}, sources: {}, warnings: [] };
  if (request.op === "settings.read")
    result = {
      doc: {},
      text: "",
      exists: false,
      path: `${root}/.zeros/settings.local.toml`,
    };
  if (request.op === "workspace.list") result = { workspaces: [] };
  return {
    type: "WORKSPACE_RESPONSE",
    requestId: request.requestId ?? "fixture",
    result,
  } as T;
};
// Cloud settings use the same synthetic transport boundary in this fixture.
WorkspaceRuntimeClient.prototype.request = RuntimeClient.prototype.request;

function Harness() {
  const projectId = useWorkspaceStore((snapshot) => snapshot.activeRepoId);
  const page = useWorkspaceStore((snapshot) => snapshot.activePage);
  const project =
    projects.find((candidate) => candidate.id === projectId) ?? projects[0];
  return (
    <TooltipProvider>
      <ActionsCtx.Provider value={sessions}>
        <BridgeProvider>
          <main className="bg-bg1 flex h-screen flex-col">
            <nav
              aria-label="Fixture repositories"
              className="flex shrink-0 gap-2 p-2"
            >
              {projects.map((candidate) => (
                <Button
                  key={candidate.id}
                  variant="ghost"
                  size="sm"
                  onClick={() => openProject(candidate.id)}
                >
                  {candidate.name}
                </Button>
              ))}
            </nav>
            {page === "settings" ? (
              <AuthContext.Provider value={auth}>
                <SettingsPage />
              </AuthContext.Provider>
            ) : (
              <RepoPage project={project} />
            )}
          </main>
        </BridgeProvider>
      </ActionsCtx.Provider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
