import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatThread } from "../store";
import { selectActiveFolder, useWorkspaceStore } from "../workspace-store";

beforeAll(() => {
  const globals = globalThis as Record<string, unknown>;
  if (typeof globals.window === "undefined") {
    globals.window = {
      setTimeout: () => 0,
      clearTimeout: () => {},
      addEventListener: () => {},
    };
  }
  if (typeof globals.localStorage === "undefined") {
    const values = new Map<string, string>();
    globals.localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) =>
        void values.set(key, String(value)),
      removeItem: (key: string) => void values.delete(key),
    };
  }
});

function chat(id: string, folder: string): ChatThread {
  return {
    id,
    folder,
    agentId: "codex",
    agentName: "Codex",
    model: null,
    effort: "medium",
    permissionMode: "auto",
    title: "Untitled",
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("prepared workspace renderer intents", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ pendingAutoSend: {} });
    useWorkspaceStore.getState().dispatch({
      type: "HYDRATE_CHATS",
      chats: [],
      activeChatId: null,
    });
  });

  it("queues and consumes many exact chat sends independently", () => {
    // The value is when the turn was parked: the release site bounds its wait
    // on it (queuedFirstTurnAction) and boot recovery decides on it
    // (recoverPendingAutoSend).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const dispatch = useWorkspaceStore.getState().dispatch;
      dispatch({ type: "REQUEST_AUTO_SEND", chatId: "chat-a" });
      dispatch({ type: "REQUEST_AUTO_SEND", chatId: "chat-b" });
      // Pressing Send again while still provisioning must NOT restart the
      // clock, or repeated presses could extend the wait indefinitely.
      vi.setSystemTime(9_000);
      dispatch({ type: "REQUEST_AUTO_SEND", chatId: "chat-a" });

      expect(useWorkspaceStore.getState().pendingAutoSend).toEqual({
        "chat-a": 1_000,
        "chat-b": 1_000,
      });

      dispatch({ type: "CONSUME_AUTO_SEND", chatId: "chat-a" });
      expect(useWorkspaceStore.getState().pendingAutoSend).toEqual({
        "chat-b": 1_000,
      });

      dispatch({ type: "CONSUME_AUTO_SEND", chatId: "missing" });
      expect(useWorkspaceStore.getState().pendingAutoSend).toEqual({
        "chat-b": 1_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an exact queued send when its chat is closed", () => {
    const dispatch = useWorkspaceStore.getState().dispatch;
    const queued = chat("chat-queued", "/repo/.worktrees/queued");
    dispatch({
      type: "HYDRATE_CHATS",
      chats: [queued],
      activeChatId: queued.id,
    });
    dispatch({ type: "REQUEST_AUTO_SEND", chatId: queued.id });
    dispatch({ type: "DELETE_CHAT", id: queued.id });
    expect(useWorkspaceStore.getState().pendingAutoSend).toEqual({});
  });

  it("publishes provisional chat, route, and validation identity atomically", () => {
    const dispatch = useWorkspaceStore.getState().dispatch;
    const folder = "/repo/.worktrees/instant";
    const repoRoot = "/repo";
    dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" });

    dispatch({
      type: "ADD_CHAT",
      chat: chat("chat-instant", folder),
      openWorkspace: { repoRoot, validationPending: true },
    });

    const state = useWorkspaceStore.getState();
    expect(state.activePage).toBe("workspace");
    expect(state.activeChatId).toBe("chat-instant");
    expect(selectActiveFolder(state)).toBe(folder);
    expect(state.newAgentFolder).toBeNull();
    expect(state.lastWorkspaceFolder).toBe(folder);
    expect(state.lastWorkspaceByRepoRoot[repoRoot]).toBe(folder);
    expect(state.pendingWorkspaceValidationFolder).toBe(folder);
  });
});
