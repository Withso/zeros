// "A workspace in view always has an active chat" — reducer-level guards
// (2026-07-06). Conversation pane renders a dead pane for a null activeChatId (the
// EmptyComposer landing was deleted 2026-06-18), so ARCHIVE_CHAT / DELETE_CHAT
// must hand the selection to a live sibling in the SAME workspace whenever one
// exists, and pin newAgentFolder (so the tab strip's selection keeper can
// auto-spawn a fresh chat) when none does. DELETE_CHAT previously fell back to
// the last chat in the GLOBAL array, silently teleporting the user to another
// worktree.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import {
  useWorkspaceStore,
  selectChatToRestoreForFolder,
  selectMostRecentChatForFolder,
} from "../workspace-store";
import type { ChatThread, WorkspaceState } from "../store";

// Node test env has no DOM — same polyfill rationale as
// active-chat-per-workspace.test.ts (the store's persistence subscriber
// calls window.setTimeout on every dispatch).
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.window === "undefined") {
    g.window = {
      setTimeout: () => 0,
      clearTimeout: () => {},
      addEventListener: () => {},
    };
  }
  if (typeof g.localStorage === "undefined") {
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
  }
});

function chat(
  id: string,
  folder: string,
  updatedAt: number,
  archived = false,
): ChatThread {
  return { id, folder, updatedAt, archived } as ChatThread;
}

// Distinct folders per suite so assertions stay order-independent against the
// shared store singleton (activeChatByFolder intentionally accumulates).
const A = "/repo/wt-csi-a";
const B = "/repo/wt-csi-b";

function dispatch() {
  return useWorkspaceStore.getState().dispatch;
}
function state() {
  return useWorkspaceStore.getState();
}

describe("ARCHIVE_CHAT keeps a live selection", () => {
  beforeEach(() => {
    dispatch()({
      type: "HYDRATE_CHATS",
      chats: [chat("a1", A, 100), chat("a2", A, 300), chat("b1", B, 200)],
      activeChatId: "a1",
    });
  });

  it("hands the selection to the most-recent live sibling in the same folder", () => {
    dispatch()({ type: "ARCHIVE_CHAT", id: "a1" });
    expect(state().activeChatId).toBe("a2");
  });

  it("does not touch the selection when a non-active chat is archived", () => {
    dispatch()({ type: "ARCHIVE_CHAT", id: "a2" });
    expect(state().activeChatId).toBe("a1");
  });

  it("nulls + pins newAgentFolder only when the folder has no live chats left", () => {
    dispatch()({ type: "ARCHIVE_CHAT", id: "a2" });
    dispatch()({ type: "ARCHIVE_CHAT", id: "a1" });
    expect(state().activeChatId).toBeNull();
    // The pin lets the tab strip's keeper spawn a fresh chat in-place.
    expect(state().newAgentFolder).toBe(A);
  });
});

describe("UNARCHIVE_CHAT appends a restored tab", () => {
  it("advances the persisted strip-order timestamp past live siblings", () => {
    const live = { ...chat("live", A, 200), createdAt: 200 };
    const closed = { ...chat("closed", A, 100, true), createdAt: 100 };
    dispatch()({
      type: "HYDRATE_CHATS",
      chats: [closed, live],
      activeChatId: "live",
    });

    dispatch()({ type: "UNARCHIVE_CHAT", id: "closed" });

    const restored = state().chats.find(
      (candidate) => candidate.id === "closed",
    );
    expect(restored?.archived).toBe(false);
    expect(restored?.createdAt).toBeGreaterThan(live.createdAt);
    expect(
      state()
        .chats.filter(
          (candidate) => !candidate.archived && candidate.folder === A,
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((candidate) => candidate.id),
    ).toEqual(["live", "closed"]);
  });

  it("ignores a malformed legacy sibling timestamp", () => {
    const malformed = {
      ...chat("malformed", A, 200),
      createdAt: Number.NaN,
    };
    const closed = { ...chat("closed", A, 100, true), createdAt: 100 };
    dispatch()({
      type: "HYDRATE_CHATS",
      chats: [closed, malformed],
      activeChatId: "malformed",
    });

    dispatch()({ type: "UNARCHIVE_CHAT", id: "closed" });

    const restored = state().chats.find(
      (candidate) => candidate.id === "closed",
    );
    expect(Number.isFinite(restored?.createdAt)).toBe(true);
  });
});

describe("UPDATE_CHAT_SETTINGS preserves pane focus", () => {
  it("does not activate a background chat while it auto-binds an agent", () => {
    dispatch()({
      type: "HYDRATE_CHATS",
      chats: [chat("focused", A, 100), chat("background", A, 200)],
      activeChatId: "focused",
    });

    dispatch()({
      type: "UPDATE_CHAT_SETTINGS",
      id: "background",
      updates: { agentId: "codex", agentName: "Codex" },
    });

    expect(state().activeChatId).toBe("focused");
    expect(
      state().chats.find((item) => item.id === "background")?.agentId,
    ).toBe("codex");
  });
});

describe("DELETE_CHAT stays in the same workspace", () => {
  beforeEach(() => {
    dispatch()({
      type: "HYDRATE_CHATS",
      chats: [chat("a1", A, 100), chat("a2", A, 300), chat("b1", B, 999)],
      activeChatId: "a1",
    });
  });

  it("prefers the most-recent live sibling in the deleted chat's folder", () => {
    // b1 is globally most recent AND last in the array — the old reducer
    // (next[next.length - 1]) would have jumped the user to workspace B.
    dispatch()({ type: "DELETE_CHAT", id: "a1" });
    expect(state().activeChatId).toBe("a2");
  });

  it("falls back to the most-recent live chat anywhere when the folder empties", () => {
    dispatch()({ type: "DELETE_CHAT", id: "a2" });
    dispatch()({ type: "DELETE_CHAT", id: "a1" });
    expect(state().activeChatId).toBe("b1");
  });

  it("nulls + pins newAgentFolder when no live chats remain at all", () => {
    dispatch()({ type: "DELETE_CHAT", id: "b1" });
    dispatch()({ type: "DELETE_CHAT", id: "a2" });
    dispatch()({ type: "DELETE_CHAT", id: "a1" });
    expect(state().activeChatId).toBeNull();
    expect(state().newAgentFolder).toBe(A);
  });

  it("does not touch the selection when a non-active chat is deleted", () => {
    dispatch()({ type: "DELETE_CHAT", id: "b1" });
    expect(state().activeChatId).toBe("a1");
  });
});

describe("selectChatToRestoreForFolder", () => {
  function stateWith(partial: {
    chats?: ChatThread[];
    activeChatByFolder?: Record<string, string>;
  }): WorkspaceState {
    return {
      chats: partial.chats ?? [],
      activeChatByFolder: partial.activeChatByFolder ?? {},
    } as WorkspaceState;
  }

  it("prefers the remembered (last-viewed) chat over the most-recent one", () => {
    const s = stateWith({
      chats: [chat("c-old", A, 1), chat("c-new", A, 2)],
      activeChatByFolder: { [A]: "c-old" },
    });
    expect(selectChatToRestoreForFolder(s, A)).toBe("c-old");
  });

  it("falls back to the most-recent live chat when nothing is remembered", () => {
    const s = stateWith({
      chats: [chat("c-old", A, 1), chat("c-new", A, 2), chat("x", B, 9)],
    });
    expect(selectChatToRestoreForFolder(s, A)).toBe("c-new");
  });

  it("skips archived chats entirely", () => {
    const s = stateWith({
      chats: [chat("c1", A, 5, true)],
      activeChatByFolder: { [A]: "c1" },
    });
    expect(selectChatToRestoreForFolder(s, A)).toBeNull();
    expect(selectMostRecentChatForFolder(s, A)).toBeNull();
  });

  it("returns null for a null folder", () => {
    expect(selectChatToRestoreForFolder(stateWith({}), null)).toBeNull();
  });
});
