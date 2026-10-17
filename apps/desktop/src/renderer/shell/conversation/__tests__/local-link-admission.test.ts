import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread } from "../../../state/store";

// Render the real ChatView/ChatBody and commit their effects without a DOM.
// Session admission is the boundary: an adopt miss must never create/resume.
const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
  chat: null as ChatThread | null,
  linkedFolder: "/tree",
  passive: true,
  focused: true,
  draft: false,
  bridgeStatus: "connected",
  sessionStatus: "idle",
  load: vi.fn(),
  ensure: vi.fn(),
  hydrate: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) =>
    harness.effects.push(effect),
  useLayoutEffect: (effect: () => void | (() => void)) =>
    harness.effects.push(effect),
  useRef: (value: unknown) =>
    (harness.refs[harness.refIndex++] ??= { current: value }),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) =>
    getSnapshot(),
}));
vi.mock("../../../state/store", () => ({
  useChatById: () => harness.chat,
  useWorkspaceDispatch: () => harness.dispatch,
  usePendingAutoSend: () => false,
}));
vi.mock("../../../state/workspace-store", () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        activeChatId: harness.focused ? harness.chat?.id : null,
        localLinkNavigation: {
          folder: harness.linkedFolder,
          passive: harness.passive,
          workspace: { path: "/tree" },
        },
      }),
    { getState: () => ({ chatComposerDrafts: {} }) },
  ),
}));
vi.mock("../../../features/agent/composer-live-drafts", () => ({
  getLiveChatDraft: () => ({ text: harness.draft ? "Saved draft" : "" }),
  liveChatDraftHasText: (draft: { text?: string }) => !!draft?.text,
  subscribeToLiveChatDrafts: () => () => {},
}));
vi.mock("../../../features/agent/agent-chat", () => ({
  AgentChat: () => null,
}));
vi.mock("../../../features/agent/sessions-hooks", () => ({
  useAgentSessions: () => ({
    hydrateChat: harness.hydrate,
    getSession: () => ({ messages: [], status: harness.sessionStatus }),
    loadIntoChat: harness.load,
  }),
  useChatSession: () => ({
    hydrateChat: harness.hydrate,
    ensureSession: harness.ensure,
    status: harness.sessionStatus,
    messages: [],
  }),
}));
vi.mock("../../../features/agent/sessions-store", () => ({
  useSessionsStore: (selector: (state: unknown) => unknown) =>
    selector({ sessions: {} }),
}));
vi.mock("../../../features/agent/model-catalog", () => ({
  envForChat: () => ({}),
  agentFamily: (id: string) => id,
}));
vi.mock("../../../features/agent/workspace-agent-registry", () => ({
  useWorkspaceAgents: () => [{ id: "codex", installed: true }],
  hasConfirmedWorkspaceAgents: () => true,
}));
vi.mock("../../../features/settings/default-agent", () => ({
  useDefaultAgent: () => ({ agentId: "codex" }),
}));
vi.mock("../../../features/agent/enabled-agents", () => ({
  useEnabledAgents: () => ({ isEnabled: () => true }),
}));
vi.mock("../../../state/pending-workspaces", () => ({
  useWorkspaceProvisioning: () => false,
}));
vi.mock("../../../platform/bridge/use-bridge", () => ({
  useBridgeStatus: () => harness.bridgeStatus,
}));
vi.mock("../../use-chat-cwd", () => ({
  useChatCwd: () => harness.chat?.folder,
}));

import { ChatView } from "../chat-view";

const cleanups: Array<() => void> = [];
async function renderChat() {
  harness.refIndex = 0;
  renderToStaticMarkup(createElement(ChatView, { chatId: harness.chat!.id }));
  for (const effect of harness.effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.effects = [];
  harness.refs = [];
  harness.linkedFolder = "/tree";
  harness.passive = true;
  harness.focused = true;
  harness.draft = false;
  harness.bridgeStatus = "connected";
  harness.sessionStatus = "idle";
  harness.chat = {
    id: "linked",
    folder: "/tree",
    agentId: "codex",
    agentName: "Codex",
    kind: "chat",
    title: "Saved",
    model: null,
    effort: "high",
    permissionMode: "auto",
    createdAt: 1,
    updatedAt: 1,
  };
  harness.load.mockResolvedValue(false);
  harness.hydrate.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("Local link provider admission", () => {
  it.each([false, true])(
    "only adopts an existing execution (saved binding=%s)",
    async (saved) => {
      if (saved) harness.chat!.sessionId = "saved-provider-thread";
      harness.draft = true;
      await renderChat();
      expect(harness.load).toHaveBeenCalledWith(
        "linked",
        "codex",
        saved ? expect.any(Object) : null,
        expect.objectContaining({ adoptOnly: true }),
      );
      expect(harness.ensure).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalled();
    },
  );

  it("keeps a sibling pane with a different cwd passive despite saved draft text", async () => {
    harness.chat!.folder = "/tree/subdir";
    harness.focused = false;
    harness.draft = true;
    await renderChat();
    expect(harness.load).toHaveBeenCalledWith(
      "linked",
      "codex",
      null,
      expect.objectContaining({ adoptOnly: true }),
    );
    expect(harness.ensure).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "only adopts after reconnect too (saved binding=%s)",
    async (saved) => {
      if (saved) harness.chat!.sessionId = "saved-provider-thread";
      harness.bridgeStatus = "disconnected";
      harness.sessionStatus = "failed";
      await renderChat();
      harness.load.mockClear();
      harness.bridgeStatus = "connected";
      await renderChat();
      expect(harness.load.mock.calls.length).toBeGreaterThan(1);
      for (const call of harness.load.mock.calls)
        expect(call[3]).toMatchObject({ adoptOnly: true });
      expect(harness.ensure).not.toHaveBeenCalled();
    },
  );

  it("admits normally after the user interacts with the linked context", async () => {
    harness.passive = false;
    await renderChat();
    expect(harness.ensure).toHaveBeenCalled();
  });

  it("leaves an ordinary cloud conversation's admission unchanged", async () => {
    harness.chat!.folder = "cloud://org/workspace";
    await renderChat();
    expect(harness.ensure).toHaveBeenCalled();
  });
});
