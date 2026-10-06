import { beforeEach, describe, expect, it, vi } from "vitest";
import { recoverCloudRuntimeUpgrade } from "../cloud-runtime-upgrade";
import { registerLiveChatDraftRestorer, setLiveChatDraft, getLiveChatDraft } from "../composer-live-drafts";
import { BLANK, useSessionsStore } from "../sessions-store";
import type { AgentTextMessage } from "../use-agent-session";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), workspace: { chats: [{ id: "chat" }], chatComposerDrafts: {} as Record<string, unknown>, dispatch: vi.fn() } }));
vi.mock("../workspace-agent-registry", () => ({ reportCloudAgentRuntimeUpgrade: mocks.refresh, invalidateCloudAgentRegistry: vi.fn() }));
vi.mock("../../../state/store", () => ({ useWorkspaceStore: { getState: () => mocks.workspace } }));
vi.mock("../../../state/workspace-store", () => ({ useWorkspaceStore: { getState: () => mocks.workspace } }));
const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const message: AgentTextMessage = { id: "turn", kind: "text", role: "user", text: "Keep @file", createdAt: 1,
  attachments: [{ name: "sample.txt", mimeType: "text/plain", kind: "text", diskPath: "/workspace/sample.txt" }] };
function setup(cwd = folder) {
  useSessionsStore.setState({ sessions: { chat: { ...BLANK, cwd, agentId: "codex", sessionId: "session", status: "streaming", messages: [message] } } });
  const pause = vi.fn(), persist = vi.fn();
  const recover = (error: unknown = "cloud_runtime_upgrade_required", draft?: Parameters<typeof recoverCloudRuntimeUpgrade>[0]["draft"]) => recoverCloudRuntimeUpgrade({
    folder: cwd, chatId: "chat", error, message, draft, store: useSessionsStore.getState(), pauseQueue: pause, persist,
  });
  return { recover, pause, persist };
}
beforeEach(() => {
  vi.clearAllMocks(); setLiveChatDraft("chat", null);
  mocks.workspace.chatComposerDrafts = {}; mocks.workspace.chats = [{ id: "chat" }];
});
describe("cloud runtime admission recovery", () => {
  it("restores rich draft and attachments, settles quietly, pauses successors and refreshes discovery", () => {
    const h = setup();
    const draft = { text: message.text, json: { type: "doc", content: [] }, attachments: [], designFrame: undefined };
    const restore = vi.fn(() => true), unregister = registerLiveChatDraftRestorer("chat", restore);
    try {
      expect(h.recover("cloud_runtime_upgrade_required", draft)).toBe(true);
      expect(restore).toHaveBeenCalledWith(draft);
      expect(getLiveChatDraft("chat")).toBe(draft);
      expect(mocks.workspace.dispatch).toHaveBeenCalledWith({ type: "SET_CHAT_DRAFT", chatId: "chat", draft });
      expect(h.pause).toHaveBeenCalledWith("chat");
      expect(mocks.refresh).toHaveBeenCalledWith(folder, "codex");
      expect(useSessionsStore.getState().sessions.chat).toMatchObject({ status: "ready", error: null, failure: null, activeTurnStartedAt: null, messages: [] });
    } finally { unregister(); }
  });
  it("reconstructs a queued or parked send with its attachment references", () => {
    const h = setup(); expect(h.recover()).toBe(true);
    expect(getLiveChatDraft("chat")).toMatchObject({ text: message.text, attachments: [{ name: "sample.txt", diskPath: "/workspace/sample.txt" }] });
    expect(getLiveChatDraft("chat")?.json).toBeTruthy();
  });
  it.each(["live", "parked"])("preserves newer %s typing and keeps the rejected prompt visible", mode => {
    const h = setup(), newer = { text: "Newer edit", json: null, attachments: [] };
    if (mode === "live") setLiveChatDraft("chat", newer); else mocks.workspace.chatComposerDrafts.chat = newer;
    expect(h.recover()).toBe(true);
    expect(mocks.workspace.dispatch).not.toHaveBeenCalled();
    expect(useSessionsStore.getState().sessions.chat.messages).toEqual([expect.objectContaining({ ...message, recoveryFailure: { kind: "cloud-admission", message: "cloud_runtime_upgrade_required" } })]);
    expect(h.pause).toHaveBeenCalledOnce();
  });
  it("does not recreate a deleted chat's draft", () => {
    const h = setup(); mocks.workspace.chats = [];
    expect(h.recover()).toBe(true);
    expect(mocks.workspace.dispatch).not.toHaveBeenCalled();
    expect(getLiveChatDraft("chat")).toBeNull();
    expect(h.persist).not.toHaveBeenCalled();
  });
  it.each(["cloud_runtime_upgrade_required", new Error("cloud_runtime_upgrade_required")])("leaves local workspaces unchanged for %s", error => {
    const h = setup("/local/workspace"), before = useSessionsStore.getState().sessions.chat;
    expect(h.recover(error)).toBe(false);
    expect(useSessionsStore.getState().sessions.chat).toBe(before);
    expect(h.pause).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.workspace.dispatch).not.toHaveBeenCalled();
  });
  it("does not reinterpret generic errors or unrelated prompts", () => {
    const h = setup(), before = useSessionsStore.getState().sessions.chat;
    expect(h.recover("Agent execution authority is unavailable")).toBe(false);
    expect(useSessionsStore.getState().sessions.chat).toBe(before);
    expect(h.pause).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
