// Real identity bootstrap, native-cache client, ChatView and sessions provider.
// Main's saved rows are simulated; auth, refresh and bridge work remain held.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import type { AgentMessage } from "../features/agent/use-agent-session";
import type { CloudWorkspaceDocument } from "../platform/cloud-workspace-contract";
import type { BridgeMessage } from "../platform/bridge/messages";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const user = { sub: "33333333-3333-4333-8333-333333333333", email: "fixture@example.test", name: "Fixture", provider: "workos" as const, sessionId: "fixture-sign-in" };
const NATIVE_ROWS = "zeros:fixture:cloud-native-transcript";
const fixture = {
  seeded: false, bootReads: [] as string[], historyReads: [] as string[], otherRequests: 0,
  firstFrame: null as null | { painted: boolean; loading: boolean; provisional: boolean },
  releaseHistory: (_messages?: AgentMessage[]) => {},
};
Object.assign(window, { cloudTranscriptFixture: fixture });
window.__ZEROS_NATIVE__ = { on: () => () => {}, invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
  if (command === "auth_get_session_user") return user as T;
  if (command === "cloud_chat_cache") {
    const reply = (result: unknown) => ({ ok: true, result }) as T;
    if (args?.op === "bind") return reply({ lease: "44444444-4444-4444-8444-444444444444" });
    if (["protect", "release", "forget"].includes(String(args?.op))) return reply(null);
    if (args?.op === "list") return reply({ items: [], nextAfter: null });
    const range = JSON.parse(localStorage.getItem(NATIVE_ROWS) ?? "null");
    if (args?.op === "read") {
      const fromIndex = range ? Math.max(range.fromIndex, range.toIndex - Number(args.limit)) : 0;
      return reply({ range: range && { ...range, fromIndex, rows: range.rows.slice(fromIndex - range.fromIndex) }, pending: null });
    }
    if (args?.op === "read-before") {
      const index = range?.rows.findIndex((row: { msgId: string }) => row.msgId === args.before) ?? -1;
      const fromIndex = Math.max(0, index - Number(args.limit));
      return reply(index < 0 || args.revision !== range.revision ? null :
        { ...range, fromIndex, toIndex: index, rows: range.rows.slice(fromIndex, index) });
    }
  }
  return new Promise(() => {});
} };

const { cloudScopedId, cloudWorkspaceKey } = await import("../platform/bridge/cloud-workspace-key");
const { RuntimeClient } = await import("../platform/bridge/ws-client");
const { WorkspaceRuntimeClient } = await import("../platform/bridge/workspace-runtime-client");
const folder = cloudWorkspaceKey(target), chatId = cloudScopedId(target, "restart"), hiddenId = cloudScopedId(target, "hidden");
const messages: AgentMessage[] = Array.from({ length: 200 }, (_, index) => ({ id: `cached-${index}`, kind: "text",
  role: index % 2 ? "agent" : "user", text: `Cloud cached transcript row ${index}`, createdAt: index + 1 }));
const waiting: Array<(messages: AgentMessage[]) => void> = [];
RuntimeClient.prototype.connect = () => new Promise(() => {});
WorkspaceRuntimeClient.prototype.request = async function<T extends BridgeMessage = BridgeMessage>(request: Partial<BridgeMessage> & { type: string }): Promise<T> {
  const wire = request as { type: string; op?: string; params?: { chatId?: string } };
  if (wire.type === "WORKSPACE_REQUEST" && wire.op === "messages.window") {
    fixture.historyReads.push(wire.params?.chatId ?? "");
    return new Promise<T>(resolve => waiting.push(rows => resolve({ type: "WORKSPACE_RESPONSE", op: wire.op,
      result: { messages: rows.map(row => ({ msgId: row.id, kind: row.kind, payload: JSON.stringify(row), createdAt: row.createdAt })) },
    } as never)));
  }
  fixture.otherRequests++;
  return new Promise(() => {});
};
fixture.releaseHistory = (rows = messages) => { for (const resolve of waiting.splice(0)) resolve(rows); };

const { cloudTranscriptCache } = await import("../state/local-transcript-cache");
const { installAccountPresentationIdentity } = await import("../state/account-presentation");
const { useWorkspaceStore } = await import("../state/workspace-store");
const read = cloudTranscriptCache.read.bind(cloudTranscriptCache);
cloudTranscriptCache.read = id => { fixture.bootReads.push(id); return read(id); };

if (new URLSearchParams(location.search).has("seed")) {
  installAccountPresentationIdentity(user);
  const { acceptOrganizationSnapshot } = await import("../features/team/team-store");
  const { acceptCloudWorkspaceDocument } = await import("../state/cloud-workspace-catalog");
  const { sanitizeCachedChat } = await import("../state/chat-boot-cache");
  const { persistWorkspaceChatCache } = await import("../state/cloud-chat-cache");
  const { setActiveOrganizationSelection } = await import("../features/team/active-team");
  const organization = { id: target.organizationId, slug: "fixture", name: "Example organization", logo: null,
    isPersonal: false, role: "admin" as const, defaultTeamId: target.organizationId,
    workspaceCapabilities: { local: true, cloud: true }, teamCapabilities: { multiple: false as const, canCreate: false as const } };
  acceptOrganizationSnapshot({ user: { id: user.sub, email: user.email, displayName: "Fixture", staffRole: null }, organizations: [organization], teams: [organization] });
  setActiveOrganizationSelection(target.organizationId, false);
  const document: CloudWorkspaceDocument = {
    id: target.workspaceId, organizationId: target.organizationId, teamId: target.organizationId, createdBy: user.sub,
    name: "Saved cloud conversation", placement: "cloud", status: "stopped", version: 1, error: null, deletedAt: null,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    capabilities: { canWrite: true, canStart: true, canManage: true, startUnavailableReason: null },
    repository: { forge: "github.com", owner: "example", name: "fixture", revision: "main" },
    generation: { number: 1, architecture: "x86_64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "stopped", lastObservedAt: null },
  };
  acceptCloudWorkspaceDocument(document);
  const chats = [chatId, hiddenId].map(id => sanitizeCachedChat({ id, folder, title: "Saved cloud conversation", agentId: "codex", agentName: "Codex" })!);
  useWorkspaceStore.getState().dispatch({ type: "MERGE_CHATS", chats });
  useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder, repoRoot: folder, chatId });
  persistWorkspaceChatCache("chats-v1", chats);
  localStorage.setItem("zeros:ui-state:v1", JSON.stringify({ activePage: "workspace", activeChatId: chatId, lastWorkspaceFolder: folder, activeChatByFolder: { [folder]: chatId } }));
  localStorage.setItem(NATIVE_ROWS, JSON.stringify({ revision: 1, messageCount: messages.length, fromIndex: 0, toIndex: messages.length,
    rows: messages.map((row, index) => ({ index, msgId: row.id, kind: row.kind, payload: JSON.stringify(row), createdAt: row.createdAt })) }));
  fixture.seeded = true;
} else {
  // This starts the read; importing/mounting the shell does not wait for it,
  // for a bearer refresh, or for any of the held bridge promises above.
  installAccountPresentationIdentity(user);
  const [{ BridgeProvider }, { AgentSessionsProvider }, { ChatView }, { TooltipProvider }, { useSessionsStore }] = await Promise.all([
    import("../platform/bridge/use-bridge"), import("../features/agent/sessions-provider"),
    import("../shell/conversation/chat-view"), import("../shared/ui/primitives"), import("../features/agent/sessions-store"),
  ]);
  function Harness() {
    useLayoutEffect(() => {
      requestAnimationFrame(() => {
        const slot = useSessionsStore.getState().sessions[chatId];
        fixture.firstFrame = {
          painted: document.body.textContent?.includes("Cloud cached transcript row 199") === true,
          loading: [...document.querySelectorAll('[aria-label="Loading conversation"]')].some(node => node.getClientRects().length > 0),
          provisional: slot?.transcriptState === "loading" && !!slot.transcriptPresentation,
        };
      });
    }, []);
    return <div className="h-screen bg-bg1 text-fg2">
      <ChatView chatId={chatId} />
      <div hidden ref={node => node?.setAttribute("inert", "")}><ChatView chatId={hiddenId} surfaceActive={false} /></div>
    </div>;
  }
  createRoot(document.getElementById("root")!).render(<TooltipProvider><BridgeProvider><AgentSessionsProvider><Harness /></AgentSessionsProvider></BridgeProvider></TooltipProvider>);
}
