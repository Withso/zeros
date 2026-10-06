// Real tab strip and details/sharing controls; synthetic workspace/auth transport.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTabs } from "../shell/conversation/chat-tabs";
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
import { acceptOrganizationSnapshot, clearTeamStore } from "../features/team/team-store";
import { setInternalFeatureEnabled } from "../features/settings/internal-features";
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
let staffRole: "developer" | null = "developer";
let fixtureDocument = workspaceDocument;
function installActor(role: CloudWorkspaceActorRole) {
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
  setInternalFeatureEnabled("cloudComputerV2", true);
  fixtureDocument = { ...workspaceDocument, ownerUserId: ownerId, createdBy: ownerId, actorRole: role,
    sharingMode: "organization", accessRevision: 2,
    capabilities: { ...workspaceDocument.capabilities, canWrite: role !== "viewer", canEdit: ["owner", "manager", "developer"].includes(role),
      canManage: ["owner", "manager"].includes(role) } };
  acceptCloudWorkspaceDocument(fixtureDocument);
}
if (sharingFixture || runtimeFixture) {
  window.__ZEROS_NATIVE__ = {
    async invoke<T>(command: string): Promise<T> {
      if (command === "auth_get_access_token") return { access_token: "fixture-session" } as T;
      if (command === "auth_get_session_user") return {
        sub: actorIds[actorRole], accountId: actorIds[actorRole], email: "fixture@example.test", name: "Fixture", provider: "workos",
      } as T;
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
} else acceptCloudWorkspaceDocument(workspaceDocument);
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
  return (
    <ActionsCtx.Provider value={{} as SessionsActions}>
      <TooltipProvider>
        <Toaster />
        <main className="bg-bg0 text-fg1 min-h-screen p-6">
          <div className="mb-6 flex flex-wrap gap-2">
            <Button onClick={() => setCloud(true)}>Cloud fixture</Button>
            <Button onClick={() => setCloud(false)}>Local fixture</Button>
            {(sharingFixture || runtimeFixture) && <>
              <Button onClick={() => installActor("owner")}>Owner fixture</Button>
              <Button onClick={() => installActor("developer")}>Developer fixture</Button>
              <Button onClick={() => installActor("prompter")}>Prompter fixture</Button>
              <Button onClick={() => installActor("viewer")}>Viewer admin fixture</Button>
              <Button onClick={() => setInternalFeatureEnabled("cloudComputerV2", false)}>Flag off</Button>
              <Button onClick={() => dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" })}>Hide workspace</Button>
              <Button onClick={() => dispatch({ type: "SET_ACTIVE_PAGE", page: "workspace" })}>Show workspace</Button>
            </>}
          </div>
          {!sharingFixture && !runtimeFixture && <Button onClick={() => {
            acceptCloudWorkspaceDocument({ ...workspaceDocument, status: "stopped", version: 2,
              setupFailure: { code: "setup_image_contract_invalid", hasLog: false },
              error: { code: "cloud_workspace_safety_failure", message: "Managed compute stopped after a safety check failed" } });
            setFailedSetup(true);
          }}>Failed setup fixture</Button>}
          <section className="border-border1 bg-bg1 h-[500px] max-w-[740px] overflow-hidden rounded-lg border [--pane-bg:var(--bg1)]">
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
