// Per-workspace active-chat memory — restores the chat you were VIEWING when
// you switch back to a workspace. Regression guard for the bug where returning
// to a workspace always jumped to the most-recently-EDITED chat (the
// `updatedAt DESC` pick in column1's chatsByWorkspace) instead of the one you
// were looking at — selecting/viewing a chat never bumps updatedAt, so the old
// behavior silently lost the user's place across a workspace switch.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import {
  useWorkspaceStore,
  selectActiveChatForFolder,
} from "../workspace-store";
import type { ChatThread, WorkspaceState } from "../store";

// The node test env has no DOM. The store's persistence subscriber calls
// window.setTimeout on every dispatch — install a no-op `window` (and a tiny
// in-memory localStorage) so the live-store dispatches below don't throw. The
// store's MODULE-LOAD is already node-safe (see active-folder-selectors.test.ts
// which imports it without any polyfill), so installing here in beforeAll —
// after the import, before any dispatch — is sufficient. No-op timers also keep
// the debounced persist write from leaking a real timer past the test.
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

// Minimal chat — the recorder + selector only read id/folder/archived. The
// cast is sound: ChatThread is assignable to this subset (same pattern as
// active-folder-selectors.test.ts).
function chat(id: string, folder: string, archived = false): ChatThread {
  return { id, folder, archived } as ChatThread;
}

function stateWith(partial: {
  chats?: { id: string; folder: string; archived?: boolean }[];
  activeChatByFolder?: Record<string, string>;
}): WorkspaceState {
  return {
    chats: (partial.chats ?? []) as WorkspaceState["chats"],
    activeChatByFolder: partial.activeChatByFolder ?? {},
  } as WorkspaceState;
}

describe("selectActiveChatForFolder", () => {
  it("returns the remembered chat when it's live and in the folder", () => {
    const s = stateWith({
      chats: [{ id: "c1", folder: "/wt-a" }],
      activeChatByFolder: { "/wt-a": "c1" },
    });
    expect(selectActiveChatForFolder(s, "/wt-a")).toBe("c1");
  });

  it("returns null for a folder with no memory yet", () => {
    const s = stateWith({ chats: [{ id: "c1", folder: "/wt-a" }] });
    expect(selectActiveChatForFolder(s, "/wt-a")).toBeNull();
  });

  it("returns null when the remembered chat was archived (closed)", () => {
    const s = stateWith({
      chats: [{ id: "c1", folder: "/wt-a", archived: true }],
      activeChatByFolder: { "/wt-a": "c1" },
    });
    expect(selectActiveChatForFolder(s, "/wt-a")).toBeNull();
  });

  it("returns null when the remembered chat was deleted", () => {
    const s = stateWith({
      chats: [],
      activeChatByFolder: { "/wt-a": "c1" },
    });
    expect(selectActiveChatForFolder(s, "/wt-a")).toBeNull();
  });

  it("returns null when the remembered chat has moved to another folder", () => {
    const s = stateWith({
      chats: [{ id: "c1", folder: "/wt-b" }],
      activeChatByFolder: { "/wt-a": "c1" },
    });
    expect(selectActiveChatForFolder(s, "/wt-a")).toBeNull();
  });

  it("returns null for a null folder", () => {
    expect(selectActiveChatForFolder(stateWith({}), null)).toBeNull();
  });
});

describe("per-workspace active-chat recording (live store dispatch)", () => {
  // Distinct folders per describe so assertions stay order-independent against
  // the shared store singleton (the map intentionally accumulates).
  const A = "/repo/wt-acpw-a";
  const B = "/repo/wt-acpw-b";

  beforeEach(() => {
    // Fresh, known chat list each test: two chats in workspace A (the
    // multi-tab scenario), one in B.
    useWorkspaceStore.getState().dispatch({
      type: "HYDRATE_CHATS",
      chats: [chat("a1", A), chat("a2", A), chat("b1", B)],
      activeChatId: null,
    });
  });

  it("records the active chat per folder on SET_ACTIVE_CHAT", () => {
    const { dispatch } = useWorkspaceStore.getState();
    dispatch({ type: "SET_ACTIVE_CHAT", id: "a1" });
    expect(useWorkspaceStore.getState().activeChatByFolder[A]).toBe("a1");
  });

  it("restores the VIEWED chat after a round-trip — the bug fix", () => {
    const { dispatch } = useWorkspaceStore.getState();
    // View a1 in workspace A...
    dispatch({ type: "SET_ACTIVE_CHAT", id: "a1" });
    // ...switch to workspace B...
    dispatch({ type: "SET_ACTIVE_CHAT", id: "b1" });
    // ...and come back to A: the switch handler reads selectActiveChatForFolder.
    expect(selectActiveChatForFolder(useWorkspaceStore.getState(), A)).toBe(
      "a1",
    );
    // B's memory is independent and intact.
    expect(selectActiveChatForFolder(useWorkspaceStore.getState(), B)).toBe(
      "b1",
    );
  });

  it("updates the memory when the user views another chat in the same folder", () => {
    const { dispatch } = useWorkspaceStore.getState();
    dispatch({ type: "SET_ACTIVE_CHAT", id: "a1" });
    dispatch({ type: "SET_ACTIVE_CHAT", id: "a2" });
    expect(useWorkspaceStore.getState().activeChatByFolder[A]).toBe("a2");
  });

  it("leaves prior memory intact when the active chat clears (null)", () => {
    const { dispatch } = useWorkspaceStore.getState();
    dispatch({ type: "SET_ACTIVE_CHAT", id: "a1" });
    dispatch({ type: "SET_ACTIVE_CHAT", id: null });
    expect(useWorkspaceStore.getState().activeChatByFolder[A]).toBe("a1");
  });

  it("records the new chat's folder on ADD_CHAT", () => {
    const { dispatch } = useWorkspaceStore.getState();
    dispatch({ type: "ADD_CHAT", chat: chat("a3", A) });
    expect(useWorkspaceStore.getState().activeChatByFolder[A]).toBe("a3");
  });

  it("opens a workspace route and target in one state snapshot", () => {
    const { dispatch } = useWorkspaceStore.getState();
    dispatch({ type: "SET_ACTIVE_CHAT", id: "a1" });

    dispatch({
      type: "OPEN_WORKSPACE",
      folder: B,
      repoRoot: "/repo",
      chatId: "b1",
    });
    expect(useWorkspaceStore.getState()).toMatchObject({
      activePage: "workspace",
      activeChatId: "b1",
      newAgentFolder: null,
      lastWorkspaceFolder: B,
    });

    dispatch({
      type: "OPEN_WORKSPACE",
      folder: "/repo/new",
      repoRoot: "/repo",
      chatId: null,
    });
    expect(useWorkspaceStore.getState()).toMatchObject({
      activePage: "workspace",
      activeChatId: null,
      newAgentFolder: "/repo/new",
      lastWorkspaceFolder: "/repo/new",
    });
  });
});
