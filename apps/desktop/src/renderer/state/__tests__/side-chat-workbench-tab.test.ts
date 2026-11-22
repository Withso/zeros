// A side chat opens as a tab in its workspace's multi-tab column (Workbench),
// never in the main chat column it branched from.
import { describe, expect, it } from "vitest";

const stubStore = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => (stubStore.has(key) ? stubStore.get(key)! : null),
  setItem: (key: string, value: string) => void stubStore.set(key, String(value)),
  removeItem: (key: string) => void stubStore.delete(key),
  clear: () => stubStore.clear(),
};
(globalThis as Record<string, unknown>).window = {
  setTimeout: setTimeout.bind(globalThis),
  clearTimeout: clearTimeout.bind(globalThis),
  addEventListener: () => {},
  localStorage: globalThis.localStorage,
};

import {
  selectWorkbench,
  useWorkspaceStore,
  workbenchHostedChatIds,
  workbenchScopeForFolder,
} from "../workspace-store";
import type { Action, ChatThread } from "../store";
import { closeSideChat, sideChatCloseConfirmation } from "../../features/agent/side-chat";
import { cloudScopedId, cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";

const dispatch = (action: Action) => useWorkspaceStore.getState().dispatch(action);
const thread = (id: string, folder: string, over: Partial<ChatThread> = {}): ChatThread => ({
  id,
  folder,
  agentId: "codex",
  agentName: "Codex",
  model: "gpt-5",
  effort: "high",
  permissionMode: "tool-approval",
  title: id,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe("OPEN_SIDE_CHAT", () => {
  it("opens the side chat as a Workbench tab and keeps the main column on its source", () => {
    const folder = "/repo/side-chat-tab";
    dispatch({ type: "ADD_CHAT", chat: thread("source", folder) });
    dispatch({ type: "OPEN_SIDE_CHAT", chat: thread("side", folder, { parentChatId: "source", rootChatId: "source", title: "Side chat" }) });

    const state = useWorkspaceStore.getState();
    expect(state.chats.some((chat) => chat.id === "side")).toBe(true);
    const slice = selectWorkbench(state);
    const tab = slice.tabs.find((item) => item.type === "chat");
    expect(tab).toMatchObject({ type: "chat", chatId: "side", title: "Side chat" });
    expect(slice.activeId).toBe(tab!.id);
    // The side chat takes keyboard focus but lives only in its tab.
    expect(state.activeChatId).toBe("side");
    expect([...workbenchHostedChatIds(state, folder)]).toEqual(["side"]);
  });

  it("reuses one tab per side chat", () => {
    const folder = "/repo/side-chat-reuse";
    const side = thread("side-reuse", folder, { title: "Side chat" });
    dispatch({ type: "ADD_CHAT", chat: thread("source-reuse", folder) });
    dispatch({ type: "OPEN_SIDE_CHAT", chat: side });
    dispatch({ type: "OPEN_SIDE_CHAT", chat: side });
    const state = useWorkspaceStore.getState();
    expect(state.chats.filter((chat) => chat.id === side.id)).toHaveLength(1);
    const scope = state.workbenchByScope[workbenchScopeForFolder(folder)]!;
    expect(scope.tabs.filter((tab) => tab.chatId === side.id)).toHaveLength(1);
  });

  it("closes the tab when its chat is deleted", () => {
    const folder = "/repo/side-chat-delete";
    dispatch({ type: "ADD_CHAT", chat: thread("source-delete", folder) });
    dispatch({ type: "OPEN_SIDE_CHAT", chat: thread("side-delete", folder) });
    dispatch({ type: "DELETE_CHAT", id: "side-delete" });
    const state = useWorkspaceStore.getState();
    const scope = state.workbenchByScope[workbenchScopeForFolder(folder)]!;
    expect(scope.tabs.some((tab) => tab.type === "chat")).toBe(false);
    expect(workbenchHostedChatIds(state, folder).size).toBe(0);
  });

  it("brings a hosted side chat's tab forward when it is selected elsewhere", () => {
    const folder = "/repo/side-chat-select";
    dispatch({ type: "ADD_CHAT", chat: thread("source-select", folder) });
    dispatch({ type: "OPEN_SIDE_CHAT", chat: thread("side-select", folder) });
    const scopeKey = workbenchScopeForFolder(folder);
    const chatTab = useWorkspaceStore.getState().workbenchByScope[scopeKey]!.activeId;
    const other = useWorkspaceStore.getState().workbenchByScope[scopeKey]!.tabs.find((tab) => tab.type === "changes")!;
    dispatch({ type: "ACTIVATE_WORKBENCH_TAB", id: other.id, scope: scopeKey });
    dispatch({ type: "SET_ACTIVE_CHAT", id: "source-select" });
    dispatch({ type: "SET_ACTIVE_CHAT", id: "side-select" });
    expect(useWorkspaceStore.getState().workbenchByScope[scopeKey]!.activeId).toBe(chatTab);
  });

  it("opens a cloud side chat in its cloud workspace's Workbench and keeps it until that workspace confirms", () => {
    const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
    const folder = cloudWorkspaceKey(target);
    const source = thread(cloudScopedId(target, "source"), folder);
    const side = thread(cloudScopedId(target, "side"), folder, { sourceChatId: source.id, title: "Side chat" });
    dispatch({ type: "ADD_CHAT", chat: source });
    dispatch({ type: "OPEN_SIDE_CHAT", chat: side });
    const scopeKey = workbenchScopeForFolder(folder);
    expect(useWorkspaceStore.getState().workbenchByScope[scopeKey]!.tabs.some((tab) => tab.chatId === side.id)).toBe(true);
    expect([...workbenchHostedChatIds(useWorkspaceStore.getState(), folder)]).toEqual([side.id]);

    // A refresh that has not confirmed this cloud workspace keeps its side chat tab.
    dispatch({ type: "HYDRATE_CHATS", chats: [source], activeChatId: source.id, confirmedCloudWorkspaces: [] });
    expect(useWorkspaceStore.getState().workbenchByScope[scopeKey]!.tabs.some((tab) => tab.chatId === side.id)).toBe(true);
    dispatch({ type: "HYDRATE_CHATS", chats: [source], activeChatId: source.id, confirmedCloudWorkspaces: [folder] });
    expect(useWorkspaceStore.getState().workbenchByScope[scopeKey]!.tabs.some((tab) => tab.chatId === side.id)).toBe(false);
  });

  it("keeps a Local side chat tab until the Local chat list confirms", () => {
    const folder = "/repo/side-chat-unconfirmed";
    const source = thread("source-unconfirmed", folder);
    dispatch({ type: "ADD_CHAT", chat: source });
    dispatch({ type: "OPEN_SIDE_CHAT", chat: thread("side-unconfirmed", folder, { parentChatId: source.id }) });
    const scopeKey = workbenchScopeForFolder(folder);
    const hasTab = () => useWorkspaceStore.getState().workbenchByScope[scopeKey]!.tabs.some((tab) => tab.chatId === "side-unconfirmed");
    dispatch({ type: "HYDRATE_CHATS", chats: [source], activeChatId: source.id, confirmedCloudWorkspaces: [], confirmedLocalChats: false });
    expect(hasTab()).toBe(true);
    dispatch({ type: "HYDRATE_CHATS", chats: [source], activeChatId: source.id, confirmedCloudWorkspaces: [], confirmedLocalChats: true });
    expect(hasTab()).toBe(false);
  });

  it("closing a side chat tab closes the chat and returns focus to its source", () => {
    const folder = "/repo/side-chat-close";
    dispatch({ type: "ADD_CHAT", chat: thread("source-close", folder, { updatedAt: 1 }) });
    dispatch({ type: "ADD_CHAT", chat: thread("newer-close", folder, { updatedAt: 5 }) });
    dispatch({ type: "OPEN_SIDE_CHAT", chat: thread("side-close", folder, { parentChatId: "source-close", sourceChatId: "source-close" }) });
    const scopeKey = workbenchScopeForFolder(folder);
    const tab = useWorkspaceStore.getState().workbenchByScope[scopeKey]!.tabs.find((item) => item.chatId === "side-close")!;
    const closed: string[] = [];
    closeSideChat(dispatch, {
      closeSession: (id) => void closed.push(id),
      getCloseActivity: () => ({ running: false, queuedCount: 0 }),
    }, tab.id, "side-close");
    const state = useWorkspaceStore.getState();
    expect(state.workbenchByScope[scopeKey]!.tabs.some((item) => item.chatId === "side-close")).toBe(false);
    expect(state.chats.find((chat) => chat.id === "side-close")?.archived).toBe(true);
    expect(closed).toEqual(["side-close"]);
    expect(state.activeChatId).toBe("source-close");
  });

  it("closes a cloud side chat in its cloud workspace and returns focus to its source", async () => {
    const target = { organizationId: "33333333-3333-4333-8333-333333333333", workspaceId: "44444444-4444-4444-8444-444444444444" };
    const folder = cloudWorkspaceKey(target);
    const source = thread(cloudScopedId(target, "source-close"), folder);
    const side = thread(cloudScopedId(target, "side-close"), folder, { sourceChatId: source.id });
    dispatch({ type: "ADD_CHAT", chat: source });
    dispatch({ type: "OPEN_SIDE_CHAT", chat: side });
    const scopeKey = workbenchScopeForFolder(folder);
    const tab = useWorkspaceStore.getState().workbenchByScope[scopeKey]!.tabs.find((item) => item.chatId === side.id)!;
    let stopped: string | null = null;
    closeSideChat(dispatch, {
      closeSession: async (id) => { stopped = id; return true; },
      getCloseActivity: () => ({ running: true, queuedCount: 0 }),
    }, tab.id, side.id);
    await Promise.resolve();
    const state = useWorkspaceStore.getState();
    expect(stopped).toBe(side.id);
    expect(state.workbenchByScope[scopeKey]!.tabs.some((item) => item.chatId === side.id)).toBe(false);
    expect(state.chats.find((chat) => chat.id === side.id)?.archived).toBe(true);
    expect(state.activeChatId).toBe(source.id);
  });

  it("asks before closing a side chat that is running or has queued messages", () => {
    const folder = "/repo/side-chat-confirm";
    dispatch({ type: "OPEN_SIDE_CHAT", chat: thread("side-confirm", folder, { agentName: "Claude" }) });
    const activity = (running: boolean, queuedCount: number) => ({ getCloseActivity: () => ({ running, queuedCount }) });
    expect(sideChatCloseConfirmation(activity(false, 0), "side-confirm")).toBeNull();
    expect(sideChatCloseConfirmation(activity(true, 0), "side-confirm")?.title).toBe("Close running chat?");
    expect(sideChatCloseConfirmation(activity(true, 2), "side-confirm")?.description).toContain("stop Claude and discard 2 queued messages");
    expect(sideChatCloseConfirmation(activity(false, 1), "side-confirm")?.description).toContain("discard its queued message");
    expect(sideChatCloseConfirmation(activity(true, 0), "missing-side-chat")).toBeNull();
    const target = { organizationId: "55555555-5555-4555-8555-555555555555", workspaceId: "66666666-6666-4666-8666-666666666666" };
    const cloudSide = thread(cloudScopedId(target, "side-confirm"), cloudWorkspaceKey(target), { agentName: "Codex" });
    dispatch({ type: "OPEN_SIDE_CHAT", chat: cloudSide });
    expect(sideChatCloseConfirmation(activity(true, 0), cloudSide.id)?.description).toContain("stop Codex");
  });
});
