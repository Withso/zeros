import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread } from "../../../state/store";
import type { BridgeRegistryAgent } from "../../../platform/bridge/messages";

// Execute ChatView and its real binding hooks. Collect committed effects
// explicitly because the repository's Vitest environment has no DOM. Only the
// transcript UI, session actions and transport/API boundaries are mocked.
const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  chat: null as ChatThread | null,
  dispatch: vi.fn(),
  hydrate: vi.fn<() => Promise<void>>(),
  spawn: vi.fn(),
  listAgents: vi.fn<() => Promise<BridgeRegistryAgent[]>>(),
  bridgeRequest: vi.fn(),
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
  useChatSession: () => ({ status: "ready", hydrateChat: harness.hydrate, ensureSession: harness.spawn }),
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
vi.mock("../../../features/auth/auth-store", () => ({
  getSession: () => new Promise(() => {}),
  onAuthStateChange: () => () => {},
}));
vi.mock("../../../platform/cloud-workspace-access", () => ({
  cloudWorkspaceCapability: async () => ({ enabled: false }),
}));

import { ChatView } from "../chat-view";
import { clearProvisionalBindings } from "../auto-bind-chat";
import { clearCloudAgentRegistry } from "../../../features/agent/workspace-agent-registry";
import { setActiveBridge } from "../../../platform/bridge/active-bridge";
import type { RuntimeClient } from "../../../platform/bridge/ws-client";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";

const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const agentless = (id: string, folder: string): ChatThread => ({
  id, folder, agentId: null, agentName: null, kind: "chat", title: "New chat", model: null,
  effort: "high", permissionMode: "auto", createdAt: 1, updatedAt: 1,
});
const cleanups: Array<() => void> = [];
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function renderHidden(chat: ChatThread) {
  harness.chat = chat;
  renderToStaticMarkup(createElement(ChatView, { chatId: chat.id, surfaceActive: false, preparing: true }));
  for (const effect of harness.effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.effects.length = 0;
  harness.listAgents.mockResolvedValue([{ id: "codex", name: "Codex", installed: true } as BridgeRegistryAgent]);
  harness.bridgeRequest.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents: [] });
  setActiveBridge({ status: "connected", request: harness.bridgeRequest, on: () => () => {},
    onStatusChange: () => () => {} } as unknown as RuntimeClient);
  clearCloudAgentRegistry();
  clearProvisionalBindings();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  setActiveBridge(null);
  clearCloudAgentRegistry();
  clearProvisionalBindings();
});

// The Local agent registry is module state: the cloud control runs first, on
// the same cold cache the Local case then loads.
describe("hidden chat preparation by placement", () => {
  it("leaves a hidden cloud chat unbound without a registry request", async () => {
    renderHidden(agentless(cloudScopedId(target, "fresh"), cloudWorkspaceKey(target)));
    await settle();
    expect(harness.listAgents).not.toHaveBeenCalled();
    expect(harness.bridgeRequest).not.toHaveBeenCalled();
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it("keeps Local hidden preparation's registry and automatic binding behavior", async () => {
    renderHidden(agentless("local-chat", "/local/repo"));
    await settle();
    expect(harness.listAgents).toHaveBeenCalledOnce();
    expect(harness.bridgeRequest).not.toHaveBeenCalled();
    expect(harness.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "UPDATE_CHAT_SETTINGS", id: "local-chat", updates: expect.objectContaining({ agentId: "codex" }),
    }));
  });
});
