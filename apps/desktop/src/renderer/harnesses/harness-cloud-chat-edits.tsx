// Production chat tabs, reducer, catalog document and chat-edit client for a
// stopped cloud workspace. Only authentication and the control plane are
// synthetic (the smoke intercepts the edit route); the bridge only counts.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";

const userId = "11111111-1111-4111-8111-111111111111", organizationId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const bridgeCalls: string[] = [];
window.__ZEROS_NATIVE__ = {
  on: () => () => {},
  async invoke<T>(command: string): Promise<T> {
    if (command === "auth_get_access_token") return { access_token: "synthetic-chat-edits-session" } as T;
    if (command === "auth_get_session_user") return { sub: userId, accountId: userId, email: "fixture@example.test", name: "Fixture", provider: "workos" } as T;
    return null as T;
  },
};

async function main() {
  const React = await import("react"), { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("../shared/ui/primitives/tooltip");
  const { Toaster } = await import("../shared/ui/primitives/elements");
  const { ChatTabs } = await import("../shell/conversation/chat-tabs");
  const { useWorkspaceStore } = await import("../state/workspace-store");
  const { editChat } = await import("../state/cloud-chat-edits");
  const { acceptCloudWorkspaceDocument } = await import("../state/cloud-workspace-catalog");
  const { cloudV2Document } = await import("../platform/cloud-v2");
  const { cloudScopedId, cloudWorkspaceKey } = await import("../platform/bridge/cloud-workspace-key");
  const { acceptOrganizationSnapshot } = await import("../features/team/team-store");
  const { setActiveOrganizationSelection } = await import("../features/team/active-team");
  const { setActiveBridge } = await import("../platform/bridge/active-bridge");
  const { ActionsCtx } = await import("../features/agent/sessions-context");
  const membership = [{ id: organizationId, slug: "fixture", name: "Organization A", logo: null, role: "owner" as const, isPersonal: false, defaultTeamId: null,
    workspaceCapabilities: { local: true, cloud: true }, teamCapabilities: { multiple: false as const, canCreate: false as const } }];
  acceptOrganizationSnapshot({ user: { id: userId, email: "fixture@example.test", displayName: "Fixture", staffRole: null }, organizations: membership, teams: membership });
  setActiveOrganizationSelection(organizationId, false);
  const target = { organizationId, workspaceId }, folder = cloudWorkspaceKey(target);
  acceptCloudWorkspaceDocument(cloudV2Document({ id: workspaceId, organizationId, creatorUserId: userId, name: "w-7", number: 7, title: "Fix login",
    repository: "example/repo", branch: "zeros/fix", baseBranch: "main", state: "stopped", errorCode: null, createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z", version: 2, chatEdits: 1,
    capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] } }));
  // Any bridge use here would mean the edit tried to reach (and wake) the VM.
  setActiveBridge(new Proxy({ executionIdentity: { kind: "local", sidecar: "active" }, status: "connected" } as Record<string, unknown>, {
    get: (object, key) => key in object ? object[key as string] : (...args: unknown[]) => {
      const message = args[0] as { type?: string; op?: string } | undefined;
      bridgeCalls.push(key === "request" || key === "requestConnected" || key === "send" ? `${String(key)} ${message?.type ?? ""} ${message?.op ?? ""}`.trim() : String(key)); return key.toString().startsWith("on") ? () => {} : Promise.resolve({ type: "WORKSPACE_RESPONSE", result: {} }) as unknown;
    },
  }) as never);
  const chat = (id: string, title: string): import("../state/store").ChatThread => ({ id: cloudScopedId(target, id), folder, agentId: "codex", agentName: "Codex",
    model: null, effort: "high", permissionMode: "auto", title, createdAt: 1, updatedAt: 1 });
  useWorkspaceStore.setState({ chats: [chat("first", "First chat"), chat("second", "Second chat")], activeChatId: cloudScopedId(target, "first") });
  (window as unknown as { __chatEdits: unknown }).__chatEdits = {
    chats: () => useWorkspaceStore.getState().chats.map(({ id, title, archived }) => ({ id, title, archived: archived === true })),
    bridgeCalls: () => [...bridgeCalls],
  };
  function Harness() {
    const chats = useWorkspaceStore(state => state.chats), activeChatId = useWorkspaceStore(state => state.activeChatId);
    const dispatch = useWorkspaceStore(state => state.dispatch);
    return <main className="bg-bg1 min-h-screen p-8"><div className="max-w-2xl">
      <ChatTabs workspaceFolder={folder} paneId="main" chats={chats.filter(row => !row.archived)} historyChats={chats.filter(row => row.archived)}
        activeChatId={activeChatId} showSyntheticUntitled={false} onSelectUntitled={() => {}} onPrefetchChat={() => {}}
        onSelectChat={id => dispatch({ type: "SET_ACTIVE_CHAT", id })}
        onCloseTab={(row, event) => { event?.stopPropagation(); editChat(dispatch, row.id, { archived: true }); }}
        onRestoreChat={row => editChat(dispatch, row.id, { archived: false })} onSplit={() => {}} canSplitRight={false} canSplitDown={false} />
    </div></main>;
  }
  createRoot(document.getElementById("root")!).render(<ActionsCtx.Provider value={{ hydrateChat: async () => {} } as never}>
    <TooltipProvider><Harness /><Toaster /></TooltipProvider></ActionsCtx.Provider>);
}
void main();
