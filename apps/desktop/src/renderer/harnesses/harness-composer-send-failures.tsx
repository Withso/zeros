// Production chat/composer and admission recovery; synthetic native transport.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../features/agent/agent-chat";
import { ActionsCtx, type SessionsActions } from "../features/agent/sessions-context";
import { useChatSession } from "../features/agent/sessions-hooks";
import { BLANK, useSessionsStore } from "../features/agent/sessions-store";
import { getLiveChatDraft } from "../features/agent/composer-live-drafts";
import { recoverCloudAdmissionFailure } from "../features/agent/cloud-runtime-upgrade";
import { invalidateCloudAgentRegistry, warmCloudAgentRegistry } from "../features/agent/workspace-agent-registry";
import { loadAgents } from "../features/agent/agents-cache";
import { acceptOrganizationSnapshot } from "../features/team/team-store";
import { Button, TooltipProvider } from "../shared/ui/primitives";
import { Toaster } from "../shared/ui/primitives/elements/toast";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import { isCloudWorkspace } from "../platform/bridge/cloud-workspace-key";
import { acceptCloudWorkspaceDocument } from "../state/cloud-workspace-catalog";
import type { CloudWorkspaceDocument } from "../platform/cloud-workspaces";
import { useWorkspaceStore } from "../state/workspace-store";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const folder = `cloud://${organizationId}/${workspaceId}`;
const placements = [folder, "/fixture/personal/local", "/fixture/organization/local"];
const agents = [{ id: "codex", name: "Codex", installed: true, authenticated: true, version: "1.0.0", description: "", distribution: {} }];
let runtimeRequired = new URLSearchParams(location.search).has("blocked");
let error = "cloud_agent_model_not_authorized";
let sends = 0;
let reconnects = 0;

window.__ZEROS_NATIVE__ = { on: () => () => {}, async invoke<T>(command: string): Promise<T> {
  if (command === "auth_get_access_token") return { access_token: "fixture-session" } as T;
  if (command === "auth_get_session_user") return {
    sub: organizationId, accountId: organizationId, email: "fixture@example.test", name: "Fixture", provider: "workos",
  } as T;
  return null as T;
} };
setActiveBridge({ status: "connected", on: () => () => {}, onStatusChange: () => () => {},
  forceReconnect: async () => { reconnects++; },
  request: async (request: { type: string; op: string }) => request.type === "AGENT_LIST_AGENTS"
    ? { type: "AGENT_AGENTS_LIST", agents }
    : { type: "WORKSPACE_RESPONSE", op: request.op, result: {} },
} as unknown as RuntimeClient);
const organization = { id: organizationId, slug: "fixture", name: "Example organization", logo: null,
  isPersonal: false, role: "admin" as const, defaultTeamId: organizationId,
  workspaceCapabilities: { local: true, cloud: true }, teamCapabilities: { multiple: false as const, canCreate: false as const } };
acceptOrganizationSnapshot({ user: { id: organizationId, email: "fixture@example.test", displayName: "Fixture", staffRole: null },
  organizations: [organization], teams: [organization] });
let document: CloudWorkspaceDocument = {
  id: workspaceId, organizationId, teamId: organizationId, createdBy: organizationId, name: "Composer fixture",
  placement: "cloud", status: "ready", version: 1, error: null, deletedAt: null,
  createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z",
  capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
  repository: { forge: "github.com", owner: "example", name: "project", revision: "refs/heads/main" },
  generation: { number: 1, architecture: "x86_64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
    observedState: "running", lastObservedAt: null },
};
acceptCloudWorkspaceDocument(document);
const chats = placements.map((cwd, index) => ({ id: `composer-chat-${index}`, folder: cwd, agentId: "codex", agentName: "Codex",
  title: "Composer fixture", model: "gpt-6.1-sol", effort: "high" as const, permissionMode: "auto" as const,
  createdAt: 1, updatedAt: 1 }));
useWorkspaceStore.setState({ chats, activeChatId: chats[0].id, activePage: "workspace" });
for (const chat of chats) useSessionsStore.getState().setSession(chat.id, { ...BLANK, agentId: "codex", agentName: "Codex",
  cwd: chat.folder, status: "ready", transcriptState: "resident", sessionId: "fixture-session", executionId: "fixture-session" });

const actions = {
  getSession: (chatId: string) => useSessionsStore.getState().sessions[chatId],
  getSendGeneration: () => 0,
  prepareForSend: () => null,
  listAgents: async () => agents,
  hydrateChat: async () => {},
  ensureSession: async () => {},
  updateConfig: () => {},
  holdQueue: () => {}, releaseQueue: () => {},
  sendPrompt: async (chatId, text, displayText, _attachments, bubbleAttachments, segments, _autoAction, onAccepted, cloudQueue) => {
    sends++;
    const draft = getLiveChatDraft(chatId);
    const message = { id: crypto.randomUUID(), kind: "text" as const, role: "user" as const, text: displayText ?? text,
      createdAt: Date.now(), attachments: bubbleAttachments, segments };
    const store = useSessionsStore.getState(), slot = store.sessions[chatId];
    store.patchSession(chatId, { messages: [...slot.messages, message], status: "streaming" });
    onAccepted?.();
    if (isCloudWorkspace(slot.cwd)) {
      const refuse = () => recoverCloudAdmissionFailure({ folder: slot.cwd, chatId, error, message, draft,
        model: "gpt-6.1-sol", store: useSessionsStore.getState(), pauseQueue: () => {} });
      // Queue acceptance returns before readiness/admission completes. Let the
      // composer clear its accepted draft before delivering the refusal.
      if (cloudQueue) setTimeout(refuse, 0);
      else refuse();
    } else store.patchSession(chatId, { status: "ready" });
  },
} satisfies Partial<SessionsActions>;
Object.assign(window, { composerSendFailureFixture: {
  get runtimeRequired() { return runtimeRequired; },
  get sends() { return sends; },
  get reconnects() { return reconnects; },
  get document() { return document; },
  get runtimeAvailability() {
    return { organizationId, workspaceId, generation: document.generation.number,
      currentRuntimeId: `r1-${"a".repeat(64)}`, latestRuntimeId: `r1-${(runtimeRequired ? "b" : "a").repeat(64)}`,
      updateAvailable: runtimeRequired, unavailableReason: null, transition: null };
  },
  setFailure(code: string) { error = code; },
  publish(patch: Partial<CloudWorkspaceDocument>) {
    document = { ...document, ...patch, version: document.version + 1,
      updatedAt: new Date(Date.UTC(2026, 9, 1, 10) + (document.version + 1) * 1000).toISOString() };
    acceptCloudWorkspaceDocument(document);
    return document;
  },
  async refresh(required = runtimeRequired) {
    runtimeRequired = required;
    invalidateCloudAgentRegistry(folder);
    await warmCloudAgentRegistry(folder);
  },
} });
await loadAgents(actions.listAgents);
await warmCloudAgentRegistry(folder);

function Chat({ id, active }: { id: string; active: boolean }) {
  const session = useChatSession(id);
  return <AgentChat chatId={id} session={session} surfaceActive={active} onBack={() => {}} />;
}
function Harness() {
  const [selected, setSelected] = useState(0);
  const [mount, setMount] = useState(0);
  return <ActionsCtx.Provider value={actions as unknown as SessionsActions}>
    <TooltipProvider delayDuration={100}>
      <Toaster />
      <main className="bg-bg1 text-fg1 flex h-screen flex-col">
        <nav className="flex gap-2 p-4">
          {["Cloud", "Local", "Organization local"].map((label, index) => <Button key={label} onClick={() => {
            useWorkspaceStore.setState({ activeChatId: chats[index].id });
            setSelected(index);
          }}>{label}</Button>)}
          <Button onClick={() => {
            // A reload/restored surface starts from a synchronously parked
            // draft, just as the app's persistence boundary does.
            const chatId = chats[selected].id, draft = getLiveChatDraft(chatId);
            if (draft) useWorkspaceStore.getState().dispatch({ type: "SET_CHAT_DRAFT", chatId, draft });
            setMount(value => value + 1);
          }}>Remount chat</Button>
        </nav>
        <div className="flex min-h-0 w-full max-w-3xl flex-1 flex-col">
          {chats.map((chat, index) => <div key={chat.id} className={selected === index ? "flex min-h-0 flex-1 flex-col" : "hidden"}
            {...(selected === index ? {} : { inert: "" })}>
            <Chat key={mount} id={chat.id} active={selected === index} />
          </div>)}
        </div>
      </main>
    </TooltipProvider>
  </ActionsCtx.Provider>;
}
createRoot(window.document.getElementById("root")!).render(<Harness />);
