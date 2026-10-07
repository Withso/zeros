// Real tab strip and details/sharing controls; synthetic workspace/auth transport.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTabs } from "../shell/conversation/chat-tabs";
import { Cloud, Ellipsis } from "lucide-react";
import { WorkspaceHeader, WorkspaceHeaderView } from "../shell/conversation/workspace-header";
import { CloudWorkspaceDetailsContent } from "../shell/conversation/cloud-workspace-details";
import { CloudWorkspacePopover } from "../shell/conversation/cloud-workspace-popover";
import { CloudWorkspaceStatusRow } from "../shell/conversation/cloud-workspace-restart-controls";
import { CloudWorkspaceSharePopover } from "../shell/conversation/cloud-workspace-sharing-controls";
import { CloudWorkspacePortsPopover } from "../shell/conversation/cloud-workspace-ports-popover";
import { CloudWorkspaceAccessControls } from "../shell/conversation/cloud-workspace-access-controls";
import { CloudWorkspaceSyncControls } from "../shell/conversation/cloud-workspace-sync-controls";
import { ConversationSummaryProvider, ConversationSummaryTrigger } from "../shell/conversation/conversation-summary";
import {
  ActionsCtx,
  type SessionsActions,
} from "../features/agent/sessions-context";
import { Button, TooltipProvider } from "../shared/ui/primitives";
import {
  cloudScopedId,
  cloudWorkspaceKey,
} from "../platform/bridge/cloud-workspace-key";
import { acceptCloudWorkspaceDocument, clearCloudWorkspaceCatalog, cloudWorkspaceDetails, getCloudWorkspaceRows } from "../state/cloud-workspace-catalog";
import { useWorkspaceDispatch, useWorkspaceStore, type ChatThread } from "../state/store";
import type { CloudWorkspaceActorRole, CloudWorkspaceDocument } from "../platform/cloud-workspaces";
import { acceptOrganizationSnapshot, clearTeamStore, getOrganizationStoreGeneration } from "../features/team/team-store";
import { cloudReplicaCache, cloudReplicaIdentityCache, cloudReplicaIdentityKey, cloudReplicaScopeKey } from "../state/cloud-replica-cache";
import { Toaster } from "../shared/ui/primitives/elements/toast";
import { SetupView } from "../shell/workbench/tabs/setup-tab";
import { ModelPill } from "../features/agent/composer-pills";
import type { WorkspaceRegistryAgent } from "../features/agent/workspace-agent-registry";

const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const folder = cloudWorkspaceKey(target);
const workspaceDocument: CloudWorkspaceDocument = {
  id: target.workspaceId,
  organizationId: target.organizationId,
  teamId: target.organizationId,
  createdBy: target.organizationId,
  name: "Cloud workspace",
  placement: "cloud",
  status: "ready",
  version: 1,
  error: null,
  createdAt: "2026-09-26T10:00:00Z",
  updatedAt: "2026-09-26T10:00:00Z",
  deletedAt: null,
  capabilities: {
    canWrite: true,
    canManage: true,
    canStart: true,
    startUnavailableReason: null,
  },
  repository: {
    forge: "github.com",
    owner: "example",
    name: "project",
    revision: "refs/heads/main",
  },
  generation: {
    number: 1,
    architecture: "x86_64",
    resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
    observedState: "running",
    lastObservedAt: null,
  },
};
const sharingFixture = new URLSearchParams(location.search).has("sharing");
const runtimeFixture = new URLSearchParams(location.search).has("runtime");
const uiFixture = new URLSearchParams(location.search).has("ui");
const runtimeAgentsRequired = new URLSearchParams(location.search).has("agents-required");
const outdatedCloudAgents: WorkspaceRegistryAgent[] = [{
  id: "claude", name: "Claude", version: "1.0.0", description: "", distribution: {},
  installed: true, authenticated: false, runtimeUpgradeRequired: true, cloudModels: [],
}];
const ownerId = "33333333-3333-4333-8333-333333333333";
const actorIds = { owner: ownerId, manager: ownerId,
  developer: "44444444-4444-4444-8444-444444444444",
  prompter: "55555555-5555-4555-8555-555555555555",
  viewer: "66666666-6666-4666-8666-666666666666" };
let actorRole: CloudWorkspaceActorRole = "owner";
let staffRole: "developer" | null = null;
let signedOut = false;
let fixtureDocument = workspaceDocument;
function installActor(role: CloudWorkspaceActorRole) {
  signedOut = false;
  actorRole = role;
  clearTeamStore();
  clearCloudWorkspaceCatalog();
  const organization = { id: target.organizationId, slug: "fixture", name: "Example organization", logo: null,
    isPersonal: false, role: "admin" as const, defaultTeamId: target.organizationId,
    workspaceCapabilities: { local: false, cloud: true },
    teamCapabilities: { multiple: false as const, canCreate: false as const } };
  acceptOrganizationSnapshot({
    user: { id: actorIds[role], email: "fixture@example.test", displayName: "Fixture", staffRole },
    teams: [organization], organizations: [organization],
  });
    fixtureDocument = { ...workspaceDocument, ownerUserId: ownerId, createdBy: ownerId, actorRole: role,
    createdByDisplayName: "Fixture owner",
    sharingMode: "organization", accessRevision: 2,
    capabilities: { ...workspaceDocument.capabilities, canWrite: role !== "viewer", canEdit: ["owner", "manager", "developer"].includes(role),
      canManage: ["owner", "manager"].includes(role) } };
  acceptCloudWorkspaceDocument(fixtureDocument);
  if (uiFixture) {
    const identity = { accountUserId: actorIds[role], deviceId: "88888888-8888-4888-8888-888888888888" };
    cloudReplicaIdentityCache.setData(cloudReplicaIdentityKey(identity.accountUserId), identity);
    const scope = { ...identity, accountEpoch: getOrganizationStoreGeneration(), ...target };
    cloudReplicaCache.setData(cloudReplicaScopeKey(scope), { divergences: [], replica: {
      ...identity, ...target, replicaId: "99999999-9999-4999-8999-999999999999", rootPath: "/Users/fixture/Projects/cloud-workspace",
      desiredState: "active", observedState: "in_sync", manifestRevision: 1, eventCursor: 1,
      ignorePolicy: { version: 1, excludePrefixes: [] }, lastErrorCode: null,
    } });
  }
}
if (sharingFixture || runtimeFixture || uiFixture) {
  window.__ZEROS_NATIVE__ = {
    async invoke<T>(command: string): Promise<T> {
      if (signedOut && ["auth_get_access_token", "auth_get_session_user"].includes(command)) return null as T;
      if (command === "auth_get_access_token") return { access_token: "fixture-session" } as T;
      if (command === "auth_get_session_user") return {
        sub: actorIds[actorRole], accountId: actorIds[actorRole], email: "fixture@example.test", name: "Fixture", provider: "workos",
      } as T;
      if (command === "cloud_workspace_access_context") return { authorityId: ownerId, deviceId: "88888888-8888-4888-8888-888888888888", keyVersion: 1 } as T;
      if (command === "cloud_workspace_access_list") return [] as T;
      if (command === "cloud_workspace_port_forwarding_get") return { forwardingEnabled: false, autoForwardEnabled: true } as T;
      if (command === "detect_open_apps") return [] as T;
      throw new Error(`Unexpected fixture native command: ${command}`);
    },
    on: () => () => {},
  };
  Object.assign(window, { cloudWorkspaceSharingFixture: {
    get document() { return fixtureDocument; },
    get details() { return cloudWorkspaceDetails.peekSnapshot(folder).data; },
    invalidateDetails() { cloudWorkspaceDetails.invalidate(folder); },
    setPage(page: "workspace" | "dashboard") { useWorkspaceStore.getState().dispatch({ type: "SET_ACTIVE_PAGE", page }); },
    publishSharing(sharingMode: "private" | "organization", accessRevision: number) {
      fixtureDocument = { ...fixtureDocument, sharingMode, accessRevision, version: fixtureDocument.version + 1 };
      acceptCloudWorkspaceDocument(fixtureDocument);
    },
    publishName(name: string) {
      fixtureDocument = { ...fixtureDocument, name, version: fixtureDocument.version + 1, updatedAt: new Date().toISOString() };
      acceptCloudWorkspaceDocument(fixtureDocument);
      return fixtureDocument;
    },
  } });
  if (runtimeFixture) Object.assign(window, { cloudRuntimeFixture: {
    get document() { return fixtureDocument; },
    publish(patch: Partial<CloudWorkspaceDocument>) {
      fixtureDocument = { ...fixtureDocument, ...patch, version: fixtureDocument.version + 1 };
      acceptCloudWorkspaceDocument(fixtureDocument);
    },
    setStaff(role: "developer" | null) { staffRole = role; installActor("owner"); },
  } });
  installActor("owner");
} else installActor("owner");
if (uiFixture) {
  // This screenshot fixture uses the same views as production and intercepts
  // every control-plane request locally. It never contacts a cloud workspace.
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith("/v1/")) return fetchOriginal(input, init);
    let body: unknown;
    if (url.pathname.endsWith("/collaborators")) body = { ...target, accessRevision: 2, writers: { limit: 10, used: 1, available: 9 },
      members: [{ userId: ownerId, displayName: "Fixture owner", role: "owner" }], guests: [], invitations: [],
      guestCursor: null, invitationCursor: null, memberCursor: null };
    else if (url.pathname.endsWith("/detected-ports")) body = { version: 1, ...target, generation: 1, status: "ready", observedAt: new Date().toISOString(),
      ports: [{ port: 3000, protocol: "tcp", processLabel: "Web server", health: "observed", observedAt: new Date().toISOString(), closedAt: null }] };
    else if (url.pathname.endsWith("/runtime-upgrade")) body = { ...target, generation: 1, currentRuntimeId: `r1-${"a".repeat(64)}`,
      latestRuntimeId: `r1-${"a".repeat(64)}`, updateAvailable: false, unavailableReason: null, transition: null };
    else body = { workspace: fixtureDocument };
    return Response.json(body);
  };
}
function SampleDetails({ active }: { active: boolean }) {
  return <CloudWorkspacePopover workspace={fixtureDocument} active={active} label="Cloud workspace details" align="start" icon={<Cloud className="size-4" />}>
    {shown => <>
      <CloudWorkspaceDetailsContent workspace={fixtureDocument} creator="Fixture owner"
        resourceUsage={{ ...target, generation: 1, cpu: { cores: 2, usedPercent: 12.5 }, memory: { totalBytes: 4_000_000_000, usedPercent: 25 }, disk: { totalBytes: 20_000_000_000, usedPercent: 42 } }}
        status={<CloudWorkspaceStatusRow folder={folder} active={shown} inline />}
        more={<Button variant="ghost" size="icon-compact" aria-label="More workspace actions" disabled><Ellipsis /></Button>} />
      <CloudWorkspaceAccessControls workspace={fixtureDocument} active={shown} />
      <CloudWorkspaceSyncControls workspace={fixtureDocument} active={shown} />
    </>}
  </CloudWorkspacePopover>;
}
const chats: ChatThread[] = Array.from({ length: 12 }, (_, i) => ({
  id: cloudScopedId(target, `chat-${i}`),
  folder,
  agentId: "claude",
  agentName: "Claude",
  title: i === 0 ? "Workspace UI" : `Conversation ${i + 1}`,
  model: null,
  effort: "high",
  permissionMode: "auto",
  createdAt: i,
  updatedAt: i,
}));
function Harness() {
  const dispatch = useWorkspaceDispatch();
  const [cloud, setCloud] = useState(true);
  const [failedSetup, setFailedSetup] = useState(false);
  const [selected, setSelected] = useState(chats[0].id);
  const active = useWorkspaceStore(state => state.activePage === "workspace");
  useEffect(() => {
    if (uiFixture) dispatch({ type: "SET_NEW_AGENT_FOLDER", folder: cloud ? folder : "/fixture/local" });
  }, [cloud, dispatch]);
  return (
    <ActionsCtx.Provider value={{} as SessionsActions}>
      <TooltipProvider>
        <Toaster />
        <main className="bg-bg0 text-fg1 min-h-screen p-6">
          <div className="mb-6 flex flex-wrap gap-2">
            <Button onClick={() => setCloud(true)}>Cloud fixture</Button>
            <Button onClick={() => setCloud(false)}>Local fixture</Button>
            {(sharingFixture || runtimeFixture || uiFixture) && <>
              <Button onClick={() => installActor("owner")}>Owner fixture</Button>
              <Button onClick={() => installActor("developer")}>Developer fixture</Button>
              <Button onClick={() => installActor("prompter")}>Prompter fixture</Button>
              <Button onClick={() => installActor("viewer")}>Viewer admin fixture</Button>
              <Button onClick={() => { signedOut = true; clearTeamStore(); }}>Sign out fixture</Button>
              <Button onClick={() => dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" })}>Hide workspace</Button>
              <Button onClick={() => dispatch({ type: "SET_ACTIVE_PAGE", page: "workspace" })}>Show workspace</Button>
            </>}
          </div>
          {!sharingFixture && !runtimeFixture && !uiFixture && <Button onClick={() => {
            acceptCloudWorkspaceDocument({ ...workspaceDocument, status: "stopped", version: 2,
              setupFailure: { code: "setup_image_contract_invalid", hasLog: false },
              error: { code: "cloud_workspace_safety_failure", message: "Managed compute stopped after a safety check failed" } });
            setFailedSetup(true);
          }}>Failed setup fixture</Button>}
          <section data-pane-root="" className="border-border1 bg-bg1 h-[500px] max-w-[740px] overflow-hidden rounded-lg border [--pane-bg:var(--bg1)]">
            {uiFixture ? <ConversationSummaryProvider workbenchCollapsed={false} onRevealWorkbench={() => {}}>
              {cloud ? <WorkspaceHeaderView name={fixtureDocument.name} icon={<SampleDetails active={active} />}
                trailing={<ConversationSummaryTrigger />}
                actions={<><CloudWorkspaceSharePopover workspace={fixtureDocument} active={active} /><CloudWorkspacePortsPopover workspace={fixtureDocument} active={active} /></>} /> :
                <WorkspaceHeader folder="/fixture/local" name="Local feature" branch trailing={<ConversationSummaryTrigger />} />}
            </ConversationSummaryProvider> :
              <WorkspaceHeader folder={cloud ? folder : "/fixture/local"} name={cloud ? "Cloud workspace" : "Local feature"} branch={!cloud} />}
            <ChatTabs
              workspaceFolder={cloud ? folder : "/fixture/local"}
              paneId="main"
              chats={chats}
              activeChatId={selected}
              historyChats={[]}
              showSyntheticUntitled={false}
              onSelectUntitled={() => {}}
              onSelectChat={setSelected}
              onPrefetchChat={() => {}}
              onCloseTab={() => {}}
              onRestoreChat={() => {}}
              onSplit={() => {}}
              canSplitRight={false}
              canSplitDown={false}
            />
            {runtimeFixture && <div className="p-3" aria-label="Cloud composer model">
              <ModelPill agents={cloud && runtimeAgentsRequired ? outdatedCloudAgents : []} agentId="claude" initialize={null} value={null} effort="high" fast={false}
                workspaceFolder={cloud ? folder : "/fixture/local"} active={active} onChange={() => {}} onConfigure={() => {}} />
            </div>}
            {cloud && failedSetup && <section aria-label="Cloud Setup tab" className="h-64">
              <SetupView workspace={getCloudWorkspaceRows()[0]} visible onBusyChange={() => {}} />
            </section>}
          </section>
        </main>
      </TooltipProvider>
    </ActionsCtx.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
