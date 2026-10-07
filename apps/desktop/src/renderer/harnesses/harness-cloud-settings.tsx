// Real settings UI and request boundary; synthetic identities and transport only.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProvidersPanel } from "../features/settings/providers-panel";
import {
  acceptOrganizationSnapshot,
  clearTeamStore,
  getTeamStoreState,
} from "../features/team/team-store";
import { setActiveOrganizationSelection } from "../features/team/active-team";
import { clearCloudProviderConnections } from "../features/settings/cloud-provider-connection";
import { clearCloudAgentRegistry } from "../features/agent/workspace-agent-registry";
import { controlPlane } from "../features/team/control-plane";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import { CloudComputerV2Panel } from "../features/settings/cloud-computer-v2-panel";
import { CloudGithubSection } from "../features/settings/cloud-github-section";
import { clearCloudGithub } from "../platform/cloud-github";
import { clearCloudComputersV2 } from "../features/settings/cloud-computer-v2-client";
import { OpenGithubProjectDialog } from "../shell/dialogs/open-github-project";
import { acceptCloudWorkspaceDocument } from "../state/cloud-workspace-catalog";
import { notifyProjectsChanged } from "../state/use-projects";
import { ActionsCtx, type SessionsActions } from "../features/agent/sessions-context";
import { loadAgents } from "../features/agent/agents-cache";
import { useActiveOrganization, useTeams } from "../features/team/team-store";
import { cloudGithubRequestSchema } from "@zeros/protocol/github-auth";
import {
  cloudProviderAuthActionSchema,
  type CloudProviderAuthStatus,
} from "@zeros/protocol/provider-auth";
import { Toaster } from "../shared/ui/primitives/elements/toast";
import { Button, TooltipProvider } from "../shared/ui/primitives";
import { setSetting } from "../platform/settings";
import { selectActiveFolder, useWorkspaceStore } from "../state/workspace-store";
import { setCloudCreationModeOwner, pendingCloudDesignCreations } from "../state/cloud-creation-mode";
import { subscribeUserSettingsSection } from "../features/settings/settings-navigation";
import { CloudComputerAdminBadge } from "../features/settings/cloud-computer-admin-badge";

const organizationId = "11111111-1111-4111-8111-111111111111";
const organizationB = "33333333-3333-4333-8333-333333333333";
const installationId = "22222222-2222-4222-8222-222222222222";
const userA = "44444444-4444-4444-8444-444444444444";
const userB = "55555555-5555-4555-8555-555555555555";
let user = userA;
const harnessQuery = new URLSearchParams(location.search);
const computerV2Mode = harnessQuery.has("computer-v2");
let platformOwner = computerV2Mode;
const DispatcherPage = computerV2Mode ? (await import("../shell/dispatcher/dispatcher-modal")).DispatcherPage : null;
const agents = [{ id: "claude", name: "Claude Code", version: "fixture", description: "", distribution: {}, installed: true, authenticated: true }];
if (computerV2Mode) await loadAgents(async () => agents);
function installAccount(next: string) {
  user = next;
  clearTeamStore({ resetSelection: true });
  clearCloudProviderConnections();
  clearCloudAgentRegistry();
  clearCloudGithub();
  clearCloudComputersV2();
  const organization = {
    id: organizationId,
    slug: "fixture",
    name: "Example organization",
    logo: null,
    isPersonal: false,
    role: "owner" as const,
    defaultTeamId: organizationId,
    workspaceCapabilities: { local: false, cloud: true },
    teamCapabilities: { multiple: false as const, canCreate: false as const },
  };
  acceptOrganizationSnapshot({
    user: {
      id: user,
      email: "fixture@example.test",
      displayName: "Fixture",
      staffRole: platformOwner && user === userA ? "platform_owner" : null,
    },
    teams: [
      organization,
      {
        ...organization,
        id: organizationB,
        name: "Second organization",
        slug: "second",
      },
    ],
    organizations: [
      organization,
      {
        ...organization,
        id: organizationB,
        name: "Second organization",
        slug: "second",
      },
    ],
  });
  setActiveOrganizationSelection(organizationId, false);
  setSetting("organization:membership-history-v1", {
    version: 1,
    accounts: [
      {
        userId: user,
        personalId: null,
        organizationIds: [organizationId, organizationB],
        retiredOrganizationIds: [],
        updatedAt: Date.now(),
      },
    ],
  });
  if (computerV2Mode) setCloudCreationModeOwner(user);
  if (computerV2Mode && !harnessQuery.has("empty-projects")) {
    acceptCloudWorkspaceDocument({
      id: installationId, organizationId, teamId: organizationId, createdBy: user,
      name: "Fixture cloud workspace", placement: "cloud", status: "stopped", version: 1, error: null,
      createdAt: "2026-10-04T10:00:00.000Z", updatedAt: "2026-10-04T10:00:00.000Z", deletedAt: null,
      capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
      repository: { forge: "github.com", owner: "example", name: "project", revision: "refs/heads/main" },
      generation: { number: 1, architecture: "x86_64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "stopped", lastObservedAt: null },
    });
    notifyProjectsChanged();
  }
}
controlPlane.me = async () => {
  throw new Error("Harness membership refresh unavailable");
};
const nativeCalls: Array<{
  command: string;
  action?: string;
  organizationId?: string;
}> = [];
Object.assign(window, { cloudSettingsNativeCalls: nativeCalls });
const attempts = new Map<string, CloudProviderAuthStatus>();
const connected = new Map<string, boolean>();
const repository = {
  id: "123",
  owner: "example",
  name: "project",
  defaultBranch: "main",
  private: true,
};
window.__ZEROS_NATIVE__ = {
  async invoke<T>(command: string, args: unknown): Promise<T> {
    if (computerV2Mode && command === "cloud_workspace_capability") return { enabled: true } as T;
    if (command === "auth_get_access_token")
      return { access_token: `fixture-${user}` } as T;
    if (command === "auth_get_session_user")
      return {
        sub: user,
        accountId: user,
        email: "fixture@example.test",
        name: "Fixture",
        provider: "workos",
      } as T;
    if (command === "gh_cloud") {
      const body = cloudGithubRequestSchema.parse(args),
        key = JSON.stringify([user, body.organizationId]);
      nativeCalls.push({
        command,
        action: body.action,
        organizationId: body.organizationId,
      });
      if (body.action === "catalog")
        return {
          login: "fixture",
          complete: true,
          installUrl: "https://github.com/apps/zeros-test/installations/new",
          installations: [
            {
              id: installationId,
              accountLogin: "example",
              accountType: "Organization",
              connected: connected.get(key) ?? true,
              suspendedAt: null,
            },
          ],
        } as T;
      if (body.action === "repositories")
        return { repositories: [repository], nextPage: null } as T;
      if (body.action === "source") return { installationId, repository } as T;
      connected.set(key, body.action === "connect");
      return (
        body.action === "connect"
          ? { connected: true, installationId }
          : { disconnected: true }
      ) as T;
    }
    if (command === "cloud_provider_auth") {
      const body = cloudProviderAuthActionSchema.parse(args);
      nativeCalls.push({ command, action: body.action });
      if (body.action === "connect")
        attempts.set(body.attemptId, {
          attemptId: body.attemptId,
          organizationId: body.organizationId,
          provider: body.provider,
          state: "connecting",
          ...(body.provider === "codex"
            ? {
                deviceCode: {
                  verificationUrl:
                    "https://auth.openai.com/codex/device" as const,
                  userCode: "TEST-CODE",
                },
              }
            : {}),
        });
      if (body.action === "cancel") {
        const status = attempts.get(body.attemptId);
        if (status)
          attempts.set(body.attemptId, { ...status, state: "canceled" });
      }
      return attempts.get(body.attemptId) as T;
    }
    throw new Error(`Cloud settings attempted native command: ${command}`);
  },
  on: () => () => {},
};
// No cloud workspace or local CLI is present: account setup must work first.
const sourceReads: Array<{ op: string; params: unknown }> = [];
const sourceFixture = {
  reads: sourceReads,
  pendingDesign: pendingCloudDesignCreations,
  unavailable: false,
};
Object.assign(window, { cloudComputerSourceFixture: sourceFixture });
setActiveBridge({
  async request(message: { op: string; params: { owner?: string; repo?: string } }) {
    if (computerV2Mode && message.op === "gh.branchList") {
      sourceReads.push({ op: message.op, params: message.params });
      if (sourceFixture.unavailable) throw new Error("Desktop GitHub access is unavailable");
      return { type: "WORKSPACE_RESPONSE", op: message.op, result: [
        { name: "main", isDefault: true }, { name: "feature/topic", isDefault: false },
      ] };
    }
    if (computerV2Mode && message.op === "gh.prList") {
      sourceReads.push({ op: message.op, params: message.params });
      if (sourceFixture.unavailable) throw new Error("Desktop GitHub access is unavailable");
      return { type: "WORKSPACE_RESPONSE", op: message.op, result: [{
        number: 7, title: "Remote change", headBranch: "topic", baseBranch: "main", state: "open",
        url: `https://github.com/${message.params.owner}/${message.params.repo}/pull/7`,
      }] };
    }
    throw new Error("Cloud settings attempted a local engine operation");
  },
} as unknown as RuntimeClient);
installAccount(userA);
const destinations: Array<{ page: string; folder: string | null; chatId: string | null }> = [];
if (computerV2Mode) {
  useWorkspaceStore.getState().dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
  useWorkspaceStore.subscribe(state => destinations.push({ page: state.activePage, folder: selectActiveFolder(state), chatId: state.activeChatId }));
  Object.assign(window, { cloudComputerDestinations: destinations });
}
function setOrganizationRole(role: "admin" | "member") {
  const me = getTeamStoreState().me;
  if (!me) return;
  const update = (organization: (typeof me.teams)[number]) =>
    organization.id === organizationId
      ? { ...organization, role }
      : organization;
  acceptOrganizationSnapshot({
    ...me,
    user: { ...me.user, staffRole: "developer" },
    teams: me.teams.map(update),
    organizations: me.organizations?.map(update),
  });
}
function Harness() {
  const [active, setActive] = useState(true);
  const [section, setSection] = useState(computerV2Mode ? "computer" : "providers");
  const [githubOpen, setGithubOpen] = useState(false);
  useEffect(() => subscribeUserSettingsSection(section => {
    if (section === "cloud-computer") setSection("computer");
  }), []);
  const organization = useActiveOrganization(),
    { me } = useTeams();
  const folder = useWorkspaceStore(selectActiveFolder);
  const chatId = useWorkspaceStore(state => state.activeChatId);
  const workspaceOpen = useWorkspaceStore(state => state.activePage === "workspace");
  return (
    <TooltipProvider>
      <Toaster />
      <main className="bg-bg1 text-fg1 min-h-screen p-8">
        <div className="mb-6 flex gap-2">
          {computerV2Mode && <>
            <Button onClick={() => setGithubOpen(true)}>Open GitHub create</Button>
            <Button onClick={() => setSection("create")}>Create section</Button>
            <Button onClick={() => setOrganizationRole("admin")}>
              Organization admin
            </Button>
            <Button onClick={() => setOrganizationRole("member")}>
              Organization member
            </Button>
          </>}
          <Button onClick={() => installAccount(userA)}>Account A</Button>
          <Button onClick={() => installAccount(userB)}>Account B</Button>
          <Button
            onClick={() => {
              platformOwner = true;
              installAccount(user);
            }}
          >
            Platform owner
          </Button>
          <Button
            onClick={() => {
              platformOwner = false;
              installAccount(user);
            }}
          >
            Ordinary member
          </Button>
          <Button
            onClick={() =>
              setActiveOrganizationSelection(organizationId, false)
            }
          >
            Organization A
          </Button>
          <Button
            onClick={() => setActiveOrganizationSelection(organizationB, false)}
          >
            Organization B
          </Button>
          <Button onClick={() => clearTeamStore()}>Reload membership</Button>
          <Button onClick={() => setActive((value) => !value)}>
            Toggle settings activity
          </Button>
        </div>
        <div className="mb-6 flex gap-2">
          <Button onClick={() => setSection("providers")}>
            Agents section
          </Button>
          <Button onClick={() => {
            useWorkspaceStore.getState().dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
            setSection("computer");
          }}>
            Computer section
          </Button>
          <Button onClick={() => setSection("github")}>GitHub section</Button>
        </div>
        {computerV2Mode && workspaceOpen && folder && (
          <output aria-label="Opened admin workspace" data-folder={folder} data-chat-id={chatId} className="mb-6 flex items-center gap-2">
            <span>Untitled conversation</span>
            <CloudComputerAdminBadge folder={folder} />
          </output>
        )}
        {section === "providers" && <ProvidersPanel surfaceActive={active} />}
        {section === "computer" && (
          <CloudComputerV2Panel surfaceActive={active && !workspaceOpen} />
        )}
        {section === "github" && organization && me && (
          <CloudGithubSection
            key={`${me.user.id}:${organization.id}`}
            userId={me.user.id}
            organizationId={organization.id}
            surfaceActive={active}
          />
        )}
        {computerV2Mode && DispatcherPage && section === "create" && <DispatcherPage active={active} onOpenProject={() => {}} onOpenGithubProject={() => setGithubOpen(true)} onQuickStart={() => {}} />}
        {computerV2Mode && <OpenGithubProjectDialog open={githubOpen} onOpenChange={setGithubOpen} />}
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<ActionsCtx.Provider value={{ listAgents: async () => agents } as SessionsActions}><Harness /></ActionsCtx.Provider>);
