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
});
