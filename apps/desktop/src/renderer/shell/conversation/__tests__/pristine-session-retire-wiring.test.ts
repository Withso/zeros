import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread } from "../../../state/store";

// Render the real ChatView/ChatBody and commit their effects without a DOM.
// Session actions are the boundary: hiding an untouched chat must close its
// session through the intentional close, and showing it again must re-admit.
const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  refs: new Map<string, Array<{ current: unknown }>>(),
  refIndex: 0,
  current: "",
  chats: new Map<string, ChatThread>(),
  slots: {} as Record<string, Record<string, unknown> | undefined>,
  drafts: {} as Record<string, { text: string; attachments: unknown[] }>,
  pendingAutoSend: {} as Record<string, number>,
  activity: { running: false, queuedCount: 0 },
  ensure: vi.fn(),
  load: vi.fn(),
  hydrate: vi.fn(),
  close: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useLayoutEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useRef: (value: unknown) => {
    const refs = harness.refs.get(harness.current) ?? [];
    harness.refs.set(harness.current, refs);
    return (refs[harness.refIndex++] ??= { current: value });
  },
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock("../../../state/store", () => ({
  useChatById: (id: string) => harness.chats.get(id) ?? null,
  useWorkspaceDispatch: () => harness.dispatch,
  usePendingAutoSend: () => false,
}));
vi.mock("../../../state/workspace-store", () => {
  const state = () => ({
    activeChatId: harness.current,
    localLinkNavigation: null,
    chats: [...harness.chats.values()],
    pendingAutoSend: harness.pendingAutoSend,
    chatComposerDrafts: {},
  });
  return {
    useWorkspaceStore: Object.assign(
      (selector: (value: unknown) => unknown) => selector(state()),
      { getState: state },
    ),
  };
});
vi.mock("../../../features/agent/composer-live-drafts", () => ({
  getLiveChatDraft: (id: string) => harness.drafts[id] ?? null,
  liveChatDraftHasText: (draft: { text?: string } | null) => !!draft?.text?.trim(),
  subscribeToLiveChatDrafts: () => () => {},
}));
vi.mock("../../../features/agent/agent-chat", () => ({ AgentChat: () => null }));
vi.mock("../../../features/agent/sessions-hooks", () => {
  const sessions = {
    hydrateChat: harness.hydrate,
    getSession: (id: string) => harness.slots[id],
    getCloseActivity: () => harness.activity,
    closeSession: harness.close,
    loadIntoChat: harness.load,
    listAgents: async () => [],
  };
  return {
    useAgentSessions: () => sessions,
    useChatSession: () => ({
      hydrateChat: () => harness.hydrate(harness.current),
      ensureSession: harness.ensure,
      status: "ready",
      messages: [],
    }),
  };
});
vi.mock("../../../features/agent/sessions-store", () => ({
  useSessionsStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ sessions: harness.slots }),
    { getState: () => ({ sessions: harness.slots }) },
  ),
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
  useBridgeStatus: () => "connected",
}));
vi.mock("../../use-chat-cwd", () => ({
  useChatCwd: () => harness.chats.get(harness.current)?.folder,
}));

import { ChatView } from "../chat-view";
import { HIDDEN_PRISTINE_SESSION_GRACE_MS } from "../pristine-session-retire";

const LOCAL = "/organization/repo";
const CLOUD = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const placements = [
  { placement: "Local", folder: LOCAL, closeArgs: [] as unknown[] },
  { placement: "cloud", folder: CLOUD, closeArgs: [{ reason: "agent-switch" }] as unknown[] },
];

let run = 0;
const mounted = new Map<string, Array<() => void>>();
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function liveSlot(folder: string): Record<string, unknown> {
  return {
    agentId: "codex", status: "ready", executionId: "execution", sessionId: "execution",
    cwd: folder, hasTranscript: false, transcriptState: "resident", messages: [],
    pendingPermission: null, pendingPermissions: [], pendingQuestions: [],
    activeTurnStartedAt: null, foregroundTurnId: null, providerBinding: null,
  };
}

function addChat(name: string, folder: string): string {
  const id = `${name}-${run}`;
  harness.chats.set(id, {
    id, folder, agentId: "codex", agentName: "Codex", kind: "chat", title: "Untitled",
    model: null, effort: "high", permissionMode: "auto", createdAt: 1, updatedAt: 1,
  });
  harness.slots[id] = liveSlot(folder);
  return id;
}

async function render(chatId: string, surfaceActive: boolean) {
  for (const cleanup of mounted.get(chatId) ?? []) cleanup();
  harness.current = chatId;
  harness.refIndex = 0;
  renderToStaticMarkup(createElement(ChatView, { chatId, surfaceActive }));
  const cleanups: Array<() => void> = [];
  for (const effect of harness.effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
  mounted.set(chatId, cleanups);
  await settle();
}

const closedIds = () => harness.close.mock.calls.map((call) => call[0]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  run++;
  harness.effects = [];
  harness.refs.clear();
  harness.chats.clear();
  harness.slots = {};
  harness.drafts = {};
  harness.pendingAutoSend = {};
  harness.activity = { running: false, queuedCount: 0 };
  harness.hydrate.mockResolvedValue(undefined);
  harness.load.mockResolvedValue(false);
  harness.close.mockImplementation(() => undefined);
});
afterEach(async () => {
  for (const cleanups of mounted.values()) for (const cleanup of cleanups) cleanup();
  mounted.clear();
  await settle();
  vi.advanceTimersByTime(HIDDEN_PRISTINE_SESSION_GRACE_MS);
  vi.useRealTimers();
});

describe.each(placements)("pristine session retirement ($placement)", ({ folder, closeArgs }) => {
  it("closes an earlier hidden untouched session at once and keeps the latest for two minutes", async () => {
    const a = addChat("a", folder), b = addChat("b", folder);
    await render(a, true);
    await render(b, true);
    await render(a, false);
    expect(harness.close).not.toHaveBeenCalled();
    await render(b, false);
    expect(harness.close.mock.calls).toEqual([[a, ...closeArgs]]);
    vi.advanceTimersByTime(HIDDEN_PRISTINE_SESSION_GRACE_MS - 1);
    expect(closedIds()).toEqual([a]);
    vi.advanceTimersByTime(1);
    expect(harness.close.mock.calls).toEqual([[a, ...closeArgs], [b, ...closeArgs]]);
  });

  it("cancels the retirement when the chat is shown again", async () => {
    const a = addChat("a", folder);
    await render(a, true);
    await render(a, false);
    vi.advanceTimersByTime(60_000);
    await render(a, true);
    vi.advanceTimersByTime(HIDDEN_PRISTINE_SESSION_GRACE_MS * 2);
    expect(harness.close).not.toHaveBeenCalled();
    expect(harness.ensure).not.toHaveBeenCalled();
  });

  it("re-admits a retired chat when it is shown again, without an error or a settings write", async () => {
    const a = addChat("a", folder);
    harness.close.mockImplementation((id: string) => {
      harness.slots[id] = folder === CLOUD
        ? { ...liveSlot(folder), status: "idle", executionId: null, sessionId: null }
        : undefined;
    });
    await render(a, true);
    expect(harness.ensure).not.toHaveBeenCalled();
    await render(a, false);
    vi.advanceTimersByTime(HIDDEN_PRISTINE_SESSION_GRACE_MS);
    expect(closedIds()).toEqual([a]);
    await render(a, true);
    expect(harness.ensure).toHaveBeenCalledOnce();
    expect(harness.ensure).toHaveBeenCalledWith("codex", expect.objectContaining({ cwd: folder }));
    expect(harness.load).not.toHaveBeenCalled();
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it.each<[string, (id: string) => void]>([
    ["composer text", (id) => { harness.drafts[id] = { text: "half a thought", attachments: [] }; }],
    ["a composer attachment", (id) => { harness.drafts[id] = { text: "", attachments: [{ id: "file" }] }; }],
    ["a pending auto-send", (id) => { harness.pendingAutoSend[id] = 1; }],
    ["messages", (id) => { harness.slots[id] = { ...harness.slots[id], messages: [{ id: "m", kind: "text" }] }; }],
    ["a transcript", (id) => { harness.slots[id] = { ...harness.slots[id], hasTranscript: true }; }],
    ["a promoted title", (id) => { harness.chats.set(id, { ...harness.chats.get(id)!, title: "Fix the build" }); }],
    ["a streaming turn", (id) => { harness.slots[id] = { ...harness.slots[id], status: "streaming" }; }],
    ["a permission card", (id) => { harness.slots[id] = { ...harness.slots[id], pendingPermissions: [{ id: "p" }] }; }],
    ["a question card", (id) => { harness.slots[id] = { ...harness.slots[id], pendingQuestions: [{ questionId: "q" }] }; }],
  ])("never retires a chat with %s", async (_name, touch) => {
    const a = addChat("a", folder), b = addChat("b", folder);
    touch(a);
    await render(a, true);
    await render(a, false);
    await render(b, true);
    await render(b, false);
    vi.advanceTimersByTime(HIDDEN_PRISTINE_SESSION_GRACE_MS);
    expect(closedIds()).toEqual([b]);
  });

  it("never retires a chat whose queued message waits on its admission", async () => {
    const a = addChat("a", folder);
    harness.slots[a] = { ...harness.slots[a], status: "warming", executionId: null, sessionId: null };
    harness.activity = { running: false, queuedCount: 1 };
    await render(a, true);
    await render(a, false);
    vi.advanceTimersByTime(HIDDEN_PRISTINE_SESSION_GRACE_MS);
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("leaves a read-only chat alone", async () => {
    const a = addChat("a", folder);
    harness.current = a;
    harness.refIndex = 0;
    renderToStaticMarkup(createElement(ChatView, { chatId: a, surfaceActive: true, readOnly: true }));
    const cleanups = harness.effects.splice(0).map((effect) => effect()).filter(Boolean) as Array<() => void>;
    for (const cleanup of cleanups) cleanup();
    await settle();
    vi.advanceTimersByTime(HIDDEN_PRISTINE_SESSION_GRACE_MS);
    expect(harness.close).not.toHaveBeenCalled();
  });
});
