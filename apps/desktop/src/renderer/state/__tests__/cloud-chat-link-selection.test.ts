// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread } from "../store";

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast }));

import { useWorkspaceStore } from "../workspace-store";
import {
  CLOUD_CHAT_LINK_WAIT_MS,
  cancelCloudChatLinkSelection,
  selectCloudChatWhenLoaded,
} from "../cloud-chat-link-selection";

const ORG = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const KEY = `cloud://${ORG}/${WS}`;
const CHAT = `cloud:${ORG}:${WS}:chat-1`;
const chat = (id: string, patch: Partial<ChatThread> = {}): ChatThread => ({
  id, folder: KEY, title: id, createdAt: 10, updatedAt: 10,
  agentId: "claude", agentName: "Claude", model: null, effort: "high", permissionMode: "auto",
  ...patch,
});

beforeAll(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});
beforeEach(() => {
  vi.useFakeTimers();
  toast.error.mockClear();
  // Just opened: the workspace is the destination and its chats are loading.
  useWorkspaceStore.setState({
    activePage: "workspace",
    activeChatId: null,
    newAgentFolder: null,
    lastWorkspaceFolder: KEY,
    pendingChatHydrationFolder: KEY,
    chats: [],
  });
});
afterEach(() => {
  cancelCloudChatLinkSelection();
  vi.useRealTimers();
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
});

describe("landing a cloud chat link on its chat", () => {
  it("waits for the workspace's chats, then selects the linked one", () => {
    selectCloudChatWhenLoaded(KEY, CHAT);
    expect(useWorkspaceStore.getState().activeChatId).toBeNull();
    useWorkspaceStore.setState({ chats: [chat("other"), chat(CHAT)], activeChatId: "other", pendingChatHydrationFolder: null });
    expect(useWorkspaceStore.getState().activeChatId).toBe(CHAT);
    expect(toast.error).not.toHaveBeenCalled();
    // Done: a later choice is the user's.
    useWorkspaceStore.getState().dispatch({ type: "SET_ACTIVE_CHAT", id: "other" });
    vi.advanceTimersByTime(CLOUD_CHAT_LINK_WAIT_MS);
    expect(useWorkspaceStore.getState().activeChatId).toBe("other");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("selects at once when the chats are already loaded", () => {
    useWorkspaceStore.setState({ chats: [chat(CHAT)], pendingChatHydrationFolder: null });
    selectCloudChatWhenLoaded(KEY, CHAT);
    expect(useWorkspaceStore.getState().activeChatId).toBe(CHAT);
  });

  it.each([
    ["missing from the loaded list", [chat("other")]],
    ["archived", [chat(CHAT, { archived: true })]],
    ["a terminal", [chat(CHAT, { kind: "terminal" })]],
  ])("says the chat is unavailable when it is %s", (_label, chats) => {
    selectCloudChatWhenLoaded(KEY, CHAT);
    useWorkspaceStore.setState({ chats, pendingChatHydrationFolder: null });
    expect(toast.error).toHaveBeenCalledExactlyOnceWith("You don't have access to that chat.");
    expect(useWorkspaceStore.getState().activeChatId).not.toBe(CHAT);
  });

  // Review 2026-11-10: a waiting chat link selected its chat after a newer
  // link had started, and that selection's navigation retired the newer link.
  it("never selects over a newer link, which retires it", () => {
    selectCloudChatWhenLoaded(KEY, CHAT);
    const version = useWorkspaceStore.getState().navigationVersion ?? 0;
    cancelCloudChatLinkSelection();
    useWorkspaceStore.setState({ chats: [chat(CHAT)], pendingChatHydrationFolder: null });
    expect(useWorkspaceStore.getState().activeChatId).toBeNull();
    expect(useWorkspaceStore.getState().navigationVersion ?? 0).toBe(version);
    vi.advanceTimersByTime(CLOUD_CHAT_LINK_WAIT_MS);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps only the newest chat link waiting", () => {
    const second = `cloud:${ORG}:${WS}:chat-2`;
    selectCloudChatWhenLoaded(KEY, CHAT);
    selectCloudChatWhenLoaded(KEY, second);
    useWorkspaceStore.setState({ chats: [chat(CHAT), chat(second)], pendingChatHydrationFolder: null });
    expect(useWorkspaceStore.getState().activeChatId).toBe(second);
    vi.advanceTimersByTime(CLOUD_CHAT_LINK_WAIT_MS);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("settles when the chats load, so a later choice in that workspace stays the user's", () => {
    selectCloudChatWhenLoaded(KEY, CHAT);
    useWorkspaceStore.setState({ chats: [chat("other")], pendingChatHydrationFolder: null });
    expect(toast.error).toHaveBeenCalledExactlyOnceWith("You don't have access to that chat.");
    useWorkspaceStore.getState().dispatch({ type: "SET_ACTIVE_CHAT", id: "other" });
    useWorkspaceStore.setState({ chats: [chat("other"), chat(CHAT)] });
    expect(useWorkspaceStore.getState().activeChatId).toBe("other");
  });

  it.each([
    ["another workspace", { lastWorkspaceFolder: "/Users/alex/repo" }],
    ["another page", { activePage: "dashboard" as const }],
  ])("stops quietly when the user goes to %s", (_label, patch) => {
    selectCloudChatWhenLoaded(KEY, CHAT);
    useWorkspaceStore.setState(patch);
    useWorkspaceStore.setState({ chats: [chat(CHAT)], pendingChatHydrationFolder: null });
    vi.advanceTimersByTime(CLOUD_CHAT_LINK_WAIT_MS);
    expect(useWorkspaceStore.getState().activeChatId).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("gives up with an error when the chats never load", () => {
    selectCloudChatWhenLoaded(KEY, CHAT);
    vi.advanceTimersByTime(CLOUD_CHAT_LINK_WAIT_MS);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith("Couldn't open that chat. Try the link again in a moment.");
    useWorkspaceStore.setState({ chats: [chat(CHAT)], pendingChatHydrationFolder: null });
    expect(useWorkspaceStore.getState().activeChatId).toBeNull();
  });
});
