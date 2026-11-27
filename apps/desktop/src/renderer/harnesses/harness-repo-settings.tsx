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
import { AddProjectFixtureProvider, type AddProjectActions } from "../shell/add-project-provider";
import { settingsOwnerKey, writeScopedSettingsSelection } from "../features/settings/settings-scope";
import { computerKey, computers } from "../features/settings/cloud-computer-store";
import { cloudProjects, githubLevelConnections, githubLevelsKey } from "../features/settings/cloud-github-levels";
import { connectionRepositoriesCache, connectionRepositoryPageKey } from "../features/settings/github-connection-drawer";
import { readyCopyCache } from "../features/settings/ready-copy-section";
import { buildSecretNamesCache } from "../features/settings/build-secrets-section";
import { readableRepositoriesCache } from "../features/settings/cloud-project-repository-picker";
import {
  cloudComputerRepositoriesCache,
  cloudComputerRepositoriesKey,
} from "../features/settings/cloud-computer-v2-create-gate";
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
const membership = {
  user: {
    id: "fixture",
    email: "fixture@example.test",
    displayName: "Fixture",
    staffRole: null as "developer" | null,
  },
  organizations: [organization],
  teams: [organization],
};
acceptOrganizationSnapshot(membership);
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

// A repository on this Mac and on the Cloud Computer, and one only in the cloud.
// The organization's computer reads are seeded; a revalidation failure keeps them.
const BOTH = "example/cloud-settings";
const CLOUD_ONLY = "example/cloud-only";
upsertProject({ repoRoot: "/fixture/cloud-settings", name: "cloud-settings", originUrl: `https://github.com/${BOTH}.git` });
const BUILD_ID = "33333333-3333-4333-8333-333333333333";
const recipe = [{ repository: BOTH, setup: "pnpm install" }, { repository: CLOUD_ONLY }];
// Seeded after the organization snapshot, whose generation scopes the computer key.
function seedCloudComputer() {
  cloudComputerRepositoriesCache.setData(cloudComputerRepositoriesKey(membership.user.id, organization.id),
    [BOTH, CLOUD_ONLY].map(repository => {
      const [owner, name] = repository.split("/") as [string, string];
      return { id: repository, owner, name, defaultBranch: "main" };
    }));
  computers.setData(computerKey(membership.user.id, organization.id), {
    activeBuildId: BUILD_ID, snapshotName: "fixture", recipe: { repositories: recipe }, recipeRevision: 1,
    builds: [{ id: BUILD_ID, organizationId: organization.id, version: 1, recipe: { repositories: recipe }, state: "succeeded",
      snapshotId: "fixture", errorCode: null, createdAt: "2026-10-15T00:00:00Z", startedAt: "2026-10-15T00:00:00Z",
      finishedAt: "2026-10-15T00:05:00Z", reason: "manual" }],
  });
}

/** Opens a joined project page in Settings as an organization owner or member. */
async function openProjectState(state: "both-admin" | "both-member" | "cloud-only") {
  const role = state === "both-member" ? "member" : "owner";
  const next = { ...organization, role } as OrganizationSummary;
  acceptOrganizationSnapshot({ ...membership, organizations: [next], teams: [next] });
  setActiveOrganizationSelection(organization.id, false);
  seedCloudComputer();
  writeScopedSettingsSelection(settingsOwnerKey(membership.user.id, organization.id), "section",
    `project:github:${state === "cloud-only" ? CLOUD_ONLY : BOTH}`);
  // Settings reads its saved selection when it mounts, so leave it for a frame first.
  const { dispatch } = useWorkspaceStore.getState();
  dispatch({ type: "SET_ACTIVE_PAGE", page: "repo" });
  await new Promise(resolve => requestAnimationFrame(resolve));
  dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
}

/** Seeds the projects' keyed reads (no session in this fixture, so nothing is fetched). */
function seedProjects(fixture: { connections: unknown; projects: unknown; readyCopy: unknown; secrets: string[];
  readable: Record<string, unknown[]>; computer?: unknown }) {
  const key = githubLevelsKey(membership.user.id, organization.id);
  githubLevelConnections.setData(key, fixture.connections as never);
  cloudProjects.setData(key, fixture.projects as never);
  for (const project of (fixture.projects as { projects: { id: string }[] }).projects) {
    readyCopyCache.setData(JSON.stringify([organization.id, project.id]), fixture.readyCopy as never);
    buildSecretNamesCache.setData(JSON.stringify([key, project.id]), fixture.secrets);
  }
  for (const [connection, rows] of Object.entries(fixture.readable)) {
    readableRepositoriesCache.setData(JSON.stringify([key, organization.id, connection]), rows as never);
    const all = fixture.connections as { organization: { id: string }[]; personal: { id: string }[] };
    connectionRepositoriesCache.setData(connectionRepositoryPageKey(membership.user.id, organization.id, connection, 1), {
      connection: [...all.organization, ...all.personal].find(row => row.id === connection), repositories: rows, nextPage: null } as never);
  }
  if (fixture.computer) computers.setData(computerKey(membership.user.id, organization.id), fixture.computer as never);
}

/** Opens any Settings selection (a cloud project page, Cloud Computer, GitHub) as an owner or a member. */
async function openSelection(selection: string, role: "owner" | "member" = "owner") {
  const next = { ...organization, role } as OrganizationSummary;
  acceptOrganizationSnapshot({ ...membership, organizations: [next], teams: [next] });
  setActiveOrganizationSelection(organization.id, false);
  seedCloudComputer();
  writeScopedSettingsSelection(settingsOwnerKey(membership.user.id, organization.id), "section", selection);
  const { dispatch } = useWorkspaceStore.getState();
  dispatch({ type: "SET_ACTIVE_PAGE", page: "repo" });
  await new Promise(resolve => requestAnimationFrame(resolve));
  dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
}

function openProject(projectId: string) {
  const personal = projectId === projects[0].id;
  setActiveOrganizationSelection(personal ? null : organization.id, personal);
  useWorkspaceStore.getState().dispatch({ type: "OPEN_REPO_PAGE", projectId });
}

const requests: string[] = [];
// Only Clone to this Mac reaches the add-project flows from this fixture; it records the request.
const cloneRequests: unknown[] = [];
const addProject = { openGithubProject: (options: unknown) => cloneRequests.push(options) } as unknown as AddProjectActions;
Object.assign(window, {
  repoSettingsOpenApp: () => useWorkspaceStore.getState().dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" }),
  repoSettingsSetInternal: (internal: boolean) => acceptOrganizationSnapshot({
    ...membership,
    user: { ...membership.user, staffRole: internal ? "developer" : null },
  }),
  repoSettingsOpenProject: openProjectState,
  repoSettingsOpenSelection: openSelection,
  repoSettingsSeedProjects: seedProjects,
  repoSettingsRequests: requests,
  repoSettingsCloneRequests: cloneRequests,
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
  accounts: [],
  refreshAccounts: async () => {},
  switchAccount: async () => "unavailable" as const,
  signOutAccount: async () => {},
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
  // The unified project page mounts these sections together; answer with the engine's empty shapes.
  if (request.op === "filesToCopy.preview")
    result = { source: "default", rootPath: root, patterns: [], files: [], totalCount: 0, totalBytes: 0,
      truncated: false, trackedMatches: [], candidates: [], warnings: [] };
  if (request.op === "git.repoBranchCatalog")
    result = { remotes: [], effectiveRemote: "origin", remoteExists: false, baseExplicit: false, effectiveBase: "main",
      detectedDefault: null, listedRemote: null, branchSource: "local", branches: [] };
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
                  onClick={() => openProject(candidate.id)}
                >
                  {candidate.name}
                </Button>
              ))}
            </nav>
            {page === "settings" ? (
              <AuthContext.Provider value={auth}>
                <AddProjectFixtureProvider value={addProject}>
                  <SettingsPage />
                </AddProjectFixtureProvider>
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
