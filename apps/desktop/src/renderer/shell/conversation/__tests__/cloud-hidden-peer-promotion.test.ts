import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread } from "../../../state/store";
import type { BridgeRegistryAgent } from "../../../platform/bridge/messages";

// Execute ChatView, ChatBody and their real cache hooks. Collect committed
// effects explicitly because the repository's Vitest environment has no DOM.
// Only the transcript UI, session actions and transport/API boundaries are mocked.
const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  chat: null as ChatThread | null,
  dispatch: vi.fn(),
  grants: vi.fn(async () => [{ kind: "codex-api-key" }, { kind: "claude-api-key" }]),
  hydrate: vi.fn<() => Promise<void>>(),
  spawn: vi.fn(),
  listAgents: vi.fn<() => Promise<BridgeRegistryAgent[]>>(),
}));
vi.mock("react", async original => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useLayoutEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock("../../../state/store", async original => ({
  ...(await original<typeof import("../../../state/store")>()),
  useChatById: () => harness.chat,
  useWorkspaceDispatch: () => harness.dispatch,
  usePendingAutoSend: () => false,
}));
vi.mock("../../../features/agent/agent-chat", () => ({ AgentChat: () => null }));
vi.mock("../../../features/agent/sessions-hooks", () => ({
  useAgentSessions: () => ({
    hydrateChat: harness.hydrate,
    getSession: () => ({ sessionId: "live-session", status: "ready" }),
    listAgents: harness.listAgents,
    loadIntoChat: harness.spawn,
  }),
  useChatSession: () => ({
    status: "ready",
    hydrateChat: harness.hydrate,
    ensureSession: harness.spawn,
  }),
}));
vi.mock("../../../platform/bridge/use-bridge", () => ({ useBridgeStatus: () => "connected" }));
vi.mock("../../../features/settings/default-agent", async original => ({
  ...(await original<typeof import("../../../features/settings/default-agent")>()),
  useDefaultAgent: () => ({ agentId: "codex" }),
}));
vi.mock("../../../features/agent/enabled-agents", async original => ({
  ...(await original<typeof import("../../../features/agent/enabled-agents")>()),
  useEnabledAgents: () => ({ isEnabled: () => true }),
}));
vi.mock("../../use-chat-cwd", () => ({ useChatCwd: () => harness.chat?.folder }));
vi.mock("../../../state/cloud-workspace-catalog", async original => ({
  ...(await original<typeof import("../../../state/cloud-workspace-catalog")>()),
  cloudWorkspaceDocument: () => ({ status: "ready", deletedAt: null, generation: { number: 1 } }),
}));
vi.mock("../../../platform/cloud-workspaces", async original => ({
  ...(await original<typeof import("../../../platform/cloud-workspaces")>()),
  cloudAgentDelegations: harness.grants,
}));
vi.mock("../../../features/auth/auth-store", () => ({
  getSession: () => new Promise(() => {}),
  onAuthStateChange: () => () => {},
}));
vi.mock("../../../platform/cloud-workspace-access", () => ({
  cloudWorkspaceCapability: async () => ({ enabled: false }),
}));

import { ChatView } from "../chat-view";
import { finishPreparedChatView, prepareChatView, usePreparedChatId } from "../chat-intent";
import { clearProvisionalBindings, rememberProvisionalBinding, takeProvisionalBinding } from "../auto-bind-chat";
import {
  clearCloudAgentRegistry,
  invalidateCloudAgentRegistry,
  warmCloudAgentRegistry,
  workspaceAgentsSnapshot,
} from "../../../features/agent/workspace-agent-registry";
import { CloudWorkspaceLifecycle } from "../../../state/cloud-workspace-lifecycle";
import { WorkspaceRuntimeClient } from "../../../platform/bridge/workspace-runtime-client";
import type { RuntimeClient } from "../../../platform/bridge/ws-client";
import { setActiveBridge } from "../../../platform/bridge/active-bridge";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";

type Message = Parameters<RuntimeClient["request"]>[0];

const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const folder = cloudWorkspaceKey(target);
const savedChat: ChatThread = {
  id: cloudScopedId(target, "saved"), folder, agentId: "codex", agentName: "Codex",
  kind: "chat", title: "Saved conversation", model: null, effort: "high",
  permissionMode: "auto", createdAt: 1, updatedAt: 1,
};
const cleanups: Array<() => void> = [];
const clients: WorkspaceRuntimeClient[] = [];
let documentTarget: EventTarget & { visibilityState: string };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function commitEffects() {
  for (const effect of harness.effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
}

function renderChat(surfaceActive: boolean, preparing = false) {
  renderToStaticMarkup(createElement(ChatView, { chatId: harness.chat!.id, surfaceActive, preparing }));
  commitEffects();
}

function PreparedIntent() {
  return usePreparedChatId();
}

function runtime(agents = [{ id: "codex", name: "Codex", installed: true }]) {
  const request = vi.fn(async (message: Message) => {
    if (message.type === "AGENT_LIST_AGENTS") return { type: "AGENT_AGENTS_LIST", agents };
    return { type: "WORKSPACE_RESPONSE", op: "messages.window", result: { messages: [{ id: "saved-message" }] } };
  });
  const release = vi.fn();
  const open = vi.fn(async () => ({
    client: { status: "connected", on: () => () => {}, onStatusChange: () => () => {}, request } as unknown as RuntimeClient,
    scope: { ...target, root: "/workspace/repo", engineWorkspaceId: "local-main" }, release,
  }));
  const history = vi.fn(async () => ({ chats: [savedChat], chatDeletions: [] }));
  const client = new WorkspaceRuntimeClient({ workspaces: () => [], readHistory: history, open });
  clients.push(client);
  setActiveBridge(client);
  // ChatBody's real hidden-preparation effect reads authorized transcript
  // history through the same runtime owner, which must not claim a peer.
  harness.hydrate.mockImplementation(async () => {
    await client.request({ type: "WORKSPACE_REQUEST", op: "messages.window", params: { chatId: savedChat.id } } as Message);
  });
  return { client, request, release, open, history };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  harness.effects.length = 0;
  harness.chat = { ...savedChat };
  harness.hydrate.mockResolvedValue(undefined);
  harness.listAgents.mockResolvedValue([{ id: "codex", name: "Codex", installed: true } as BridgeRegistryAgent]);
  clearCloudAgentRegistry();
  clearProvisionalBindings();
  documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", documentTarget);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { setInterval, clearInterval }));
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  finishPreparedChatView(savedChat.id);
  setActiveBridge(null);
  for (const client of clients.splice(0)) client.dispose();
  clearCloudAgentRegistry();
  clearProvisionalBindings();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("hidden cloud chats retain speculative peer ownership", () => {
  // Ported from the V1b review reproduction, now including ChatBody hydration.
  it.each([true, false])("does not load a registry or promote an intent peer (preparing=%s)", async preparing => {
    const { client, request, release } = runtime();
    await client.warmWorkspace(target, { intent: true });
    renderChat(false, preparing);
    await settle();
    client.cancelSpeculativeWarmups();
    expect.soft(request.mock.calls.filter(([message]) => message.type === "AGENT_LIST_AGENTS")).toHaveLength(0);
    expect.soft(harness.grants).not.toHaveBeenCalled();
    expect.soft(release).toHaveBeenCalledOnce();
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it.each(["expiry", "window hidden"])("releases the hover peer on %s after preparing a saved cloud chat", async cleanup => {
    const { client, request, release, history } = runtime();
    // Mount the actual app visibility listener with no selected cloud owner.
    renderToStaticMarkup(createElement(CloudWorkspaceLifecycle));
    commitEffects();
    await client.warmWorkspace(target, { intent: true });
    prepareChatView(savedChat.id);
    renderChat(false, true);
    await settle();
    expect(harness.hydrate).toHaveBeenCalledOnce();
    expect(history).toHaveBeenCalledOnce();
    expect(client.hasChatSnapshot(folder)).toBe(true);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: "WORKSPACE_REQUEST", op: "messages.window" }));
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(createElement(PreparedIntent))).toBe("");
    if (cleanup === "expiry") await vi.advanceTimersByTimeAsync(15_001);
    else {
      documentTarget.visibilityState = "hidden";
      documentTarget.dispatchEvent(new Event("visibilitychange"));
    }
    expect(release).toHaveBeenCalledOnce();
    expect(harness.grants).not.toHaveBeenCalled();
  });

  it("allows actual selection to load the registry once and claim the same warmed peer", async () => {
    const { client, request, release, open } = runtime();
    await client.warmWorkspace(target, { intent: true });
    renderChat(false, true);
    await settle();
    expect(harness.grants).not.toHaveBeenCalled();
    renderChat(true);
    await settle();
    expect(request.mock.calls.filter(([message]) => message.type === "AGENT_LIST_AGENTS")).toHaveLength(1);
    expect(harness.grants).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_001);
    client.cancelSpeculativeWarmups();
    expect(release).not.toHaveBeenCalled();
  });

  it("uses retained registry data without refreshing or consuming a provisional binding while hidden", async () => {
    runtime([{ id: "claude", name: "Claude", installed: true }]);
    await warmCloudAgentRegistry(folder);
    const snapshot = workspaceAgentsSnapshot(folder);
    invalidateCloudAgentRegistry(folder);
    harness.grants.mockClear();
    const prior = { agentName: null };
    rememberProvisionalBinding(savedChat.id, prior);
    renderChat(false, true);
    await settle();
    expect.soft(harness.grants).not.toHaveBeenCalled();
    expect.soft(harness.dispatch).not.toHaveBeenCalled();
    expect(workspaceAgentsSnapshot(folder)).toBe(snapshot);
    expect(takeProvisionalBinding(savedChat.id)).toEqual(prior);
    rememberProvisionalBinding(savedChat.id, prior);
    renderChat(true);
    await settle();
    expect(harness.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "UPDATE_CHAT_SETTINGS", id: savedChat.id, updates: expect.objectContaining({ agentId: "claude" }),
    }));
  });

  it("defers an agentless cloud chat's registry load and automatic binding until visible", async () => {
    const { client, release } = runtime();
    harness.chat = { ...savedChat, agentId: null, agentName: null };
    await client.warmWorkspace(target, { intent: true });
    renderChat(false, true);
    await settle();
    expect.soft(harness.grants).not.toHaveBeenCalled();
    expect.soft(harness.dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(release).toHaveBeenCalledOnce();
    renderChat(true);
    await settle();
    expect(harness.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "UPDATE_CHAT_SETTINGS", id: savedChat.id }));
    expect(harness.grants).toHaveBeenCalledOnce();
  });

  it("keeps Local hidden preparation's registry and automatic binding behavior", async () => {
    harness.chat = { ...savedChat, id: "local-chat", folder: "/local/repo", agentId: null, agentName: null };
    renderChat(false, true);
    await settle();
    expect(harness.listAgents).toHaveBeenCalledOnce();
    expect(harness.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "UPDATE_CHAT_SETTINGS", id: "local-chat" }));
    expect(harness.grants).not.toHaveBeenCalled();
  });
});
