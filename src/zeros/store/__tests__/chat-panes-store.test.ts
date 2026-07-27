// ──────────────────────────────────────────────────────────
// chat-panes-store — reconcile subscription + action tests
// ──────────────────────────────────────────────────────────
//
// Exercises the REAL zustand stores (workspace + panes) through
// dispatch, the way the app does — the pure model is covered in
// chat-panes.test.ts; these cover the wiring the reviewers flagged:
// new-chat routing, reservation consumption, pane-memory sync, the
// boot window, and collapse-after-move (which happens without any
// workspace-store dispatch).

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceStore } from "../workspace-store";
import {
  clearChatPaneFolders,
  moveChatPaneFolder,
  useChatPanesStore,
} from "../chat-panes-store";
import {
  DEFAULT_PANE_LAYOUT,
  MAIN_PANE_ID,
  MAX_PANE_LAYOUT_FOLDERS,
  leafIds,
  paneForChat,
} from "../chat-panes";
import type { ChatThread } from "../store";

// The node test env has no DOM. The workspace store's persistence
// subscriber calls window.setTimeout on every dispatch — install a
// no-op `window` + in-memory localStorage so live-store dispatches
// don't throw (same pattern as active-chat-per-workspace.test.ts).
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

function chat(id: string, folder: string, createdAt: number): ChatThread {
  return {
    id,
    folder,
    agentId: null,
    agentName: null,
    model: null,
    effort: "medium",
    permissionMode: "auto",
    title: id,
    createdAt,
    updatedAt: createdAt,
  };
}

const FOLDER = "/w/split";

function dispatch(action: Parameters<typeof reducerDispatch>[0]) {
  reducerDispatch(action);
}
const reducerDispatch = useWorkspaceStore.getState().dispatch;

function hydrate(chats: ChatThread[], activeChatId: string | null) {
  dispatch({ type: "HYDRATE_CHATS", chats, activeChatId });
}

function layout() {
  return useChatPanesStore.getState().byFolder[FOLDER] ?? DEFAULT_PANE_LAYOUT;
}

beforeEach(() => {
  useChatPanesStore.setState({ byFolder: {}, pendingAssigns: [] });
  hydrate([], null);
});

describe("new-chat routing", () => {
  it("routes a reserved chat to its pane and consumes exactly one reservation", () => {
    const a = chat("a", FOLDER, 1);
    hydrate([a], "a");
    // Split with a to-be-spawned chat: empty pane + reservation.
    const newPane = useChatPanesStore
      .getState()
      .splitPane(FOLDER, MAIN_PANE_ID, "row", null)!;
    useChatPanesStore.getState().beginAssignNextChat(FOLDER, newPane);

    const b = chat("b", FOLDER, 2);
    dispatch({ type: "ADD_CHAT", chat: b });
    expect(paneForChat(layout(), "b")).toBe(newPane);
    expect(useChatPanesStore.getState().pendingAssigns).toHaveLength(0);

    // A second new chat must NOT reuse the consumed reservation — it
    // follows the focused pane (b's pane, since b became active).
    const c = chat("c", FOLDER, 3);
    dispatch({ type: "ADD_CHAT", chat: c });
    expect(paneForChat(layout(), "c")).toBe(newPane);
  });

  it("routes an unreserved chat to the previously-focused pane", () => {
    const a = chat("a", FOLDER, 1);
    const b = chat("b", FOLDER, 2);
    hydrate([a, b], "a");
    const newPane = useChatPanesStore
      .getState()
      .splitPane(FOLDER, MAIN_PANE_ID, "row", "b")!;
    dispatch({ type: "SET_ACTIVE_CHAT", id: "b" });
    // b is focused (in newPane) → a ⌘T-style chat lands next to b.
    const c = chat("c", FOLDER, 3);
    dispatch({ type: "ADD_CHAT", chat: c });
    expect(paneForChat(layout(), "c")).toBe(newPane);
  });

  it("does not touch unsplit folders (no byFolder entry is minted)", () => {
    const a = chat("a", FOLDER, 1);
    hydrate([a], "a");
    useChatPanesStore.getState().beginAssignNextChat(FOLDER, MAIN_PANE_ID);
    dispatch({ type: "ADD_CHAT", chat: chat("b", FOLDER, 2) });
    expect(useChatPanesStore.getState().byFolder[FOLDER]).toBeUndefined();
    // Reservation is still consumed so it can't hijack a later chat.
    expect(useChatPanesStore.getState().pendingAssigns).toHaveLength(0);
  });
});

describe("pane-active memory", () => {
  it("records the pane's displayed chat as the selection moves", () => {
    const a = chat("a", FOLDER, 1);
    const b = chat("b", FOLDER, 2);
    hydrate([a, b], "a");
    const newPane = useChatPanesStore
      .getState()
      .splitPane(FOLDER, MAIN_PANE_ID, "row", "b")!;
    dispatch({ type: "SET_ACTIVE_CHAT", id: "b" });
    expect(layout().activeByPane[newPane]).toBe("b");
    dispatch({ type: "SET_ACTIVE_CHAT", id: "a" });
    expect(layout().activeByPane[MAIN_PANE_ID]).toBe("a");
    // b's pane still remembers b.
    expect(layout().activeByPane[newPane]).toBe("b");
  });
});

describe("collapse", () => {
  it("collapses a pane when its last chat is archived", () => {
    const a = chat("a", FOLDER, 1);
    const b = chat("b", FOLDER, 2);
    hydrate([a, b], "a");
    useChatPanesStore.getState().splitPane(FOLDER, MAIN_PANE_ID, "row", "b");
    dispatch({ type: "ARCHIVE_CHAT", id: "b" });
    expect(useChatPanesStore.getState().byFolder[FOLDER]).toBeUndefined();
  });

  it("collapses the source pane after moveChatToPane even when the moved chat is already active (no workspace dispatch)", () => {
    const a = chat("a", FOLDER, 1);
    const b = chat("b", FOLDER, 2);
    hydrate([a, b], "b");
    const newPane = useChatPanesStore
      .getState()
      .splitPane(FOLDER, MAIN_PANE_ID, "row", "b")!;
    expect(leafIds(layout().root)).toHaveLength(2);
    // Drag b's tab (the active chat) back into main via center drop:
    // the UI calls moveChatToPane and then SET_ACTIVE_CHAT with the
    // SAME id — the workspace-store subscription never fires.
    useChatPanesStore.getState().moveChatToPane(FOLDER, "b", MAIN_PANE_ID);
    expect(useChatPanesStore.getState().byFolder[FOLDER]).toBeUndefined();
    expect(paneForChat(layout(), "b")).toBe(MAIN_PANE_ID);
    // The emptied pane is gone, not a dead husk.
    expect(leafIds(layout().root)).not.toContain(newPane);
  });

  it("collapses the source pane after a drop-split moves its only chat", () => {
    const a = chat("a", FOLDER, 1);
    const b = chat("b", FOLDER, 2);
    hydrate([a, b], "b");
    const paneB = useChatPanesStore
      .getState()
      .splitPane(FOLDER, MAIN_PANE_ID, "row", "b")!;
    // Drop b onto MAIN's bottom band → split main down with b. The
    // moved chat is already active, so again no workspace dispatch.
    useChatPanesStore.getState().splitPane(FOLDER, MAIN_PANE_ID, "column", "b");
    const leaves = leafIds(layout().root);
    expect(leaves).not.toContain(paneB);
    expect(leaves).toHaveLength(2);
    expect(paneForChat(layout(), "b")).not.toBe(MAIN_PANE_ID);
  });
});

describe("boot window", () => {
  it("keeps a persisted split intact across an empty hydrate followed by recovery", () => {
    const a = chat("a", FOLDER, 1);
    const b = chat("b", FOLDER, 2);
    hydrate([a, b], "a");
    const newPane = useChatPanesStore
      .getState()
      .splitPane(FOLDER, MAIN_PANE_ID, "row", "b")!;

    // Simulate the LS-empty boot: an initial empty hydrate, then the
    // SQLite recovery hydrate with the real chats.
    hydrate([], null);
    expect(leafIds(layout().root)).toEqual([MAIN_PANE_ID, newPane]);
    expect(layout().assignments["b"]).toBe(newPane);

    hydrate([a, b], "a");
    expect(leafIds(layout().root)).toEqual([MAIN_PANE_ID, newPane]);
    expect(paneForChat(layout(), "b")).toBe(newPane);
  });

  it("does not bulk-route a multi-chat hydrate to the focused pane", () => {
    const a = chat("a", FOLDER, 1);
    hydrate([a], "a");
    const newPane = useChatPanesStore
      .getState()
      .splitPane(FOLDER, MAIN_PANE_ID, "row", null)!;
    useChatPanesStore.getState().beginAssignNextChat(FOLDER, newPane);
    const b = chat("b", FOLDER, 2);
    dispatch({ type: "ADD_CHAT", chat: b });
    expect(paneForChat(layout(), "b")).toBe(newPane);

    // A sync-style arrival of several chats at once: none of them are
    // a user gesture, so they fall back to the first leaf instead of
    // piling into the focused pane.
    const c = chat("c", FOLDER, 3);
    const d = chat("d", FOLDER, 4);
    dispatch({ type: "MERGE_CHATS", chats: [c, d] });
    expect(paneForChat(layout(), "c")).toBe(MAIN_PANE_ID);
    expect(paneForChat(layout(), "d")).toBe(MAIN_PANE_ID);
  });
});

describe("owner cleanup", () => {
  it("moves descendant pane layouts and pending assignments on adapted restore", () => {
    const oldRoot = "/w/archived";
    const oldFolder = `${oldRoot}/packages/app`;
    const newRoot = "/w/archived-2";
    const newFolder = `${newRoot}/packages/app`;
    const a = chat("move-a", oldFolder, 1);
    hydrate([a], a.id);
    const pane = useChatPanesStore
      .getState()
      .splitPane(oldFolder, MAIN_PANE_ID, "row", null)!;
    useChatPanesStore.getState().beginAssignNextChat(oldFolder, pane);

    moveChatPaneFolder(oldRoot, newRoot, "/repo");

    const state = useChatPanesStore.getState();
    expect(state.byFolder[oldFolder]).toBeUndefined();
    expect(state.byFolder[newFolder]).toBeDefined();
    expect(state.pendingAssigns[0]?.folder).toBe(newFolder);
  });

  it("explicitly drops deleted folders without treating them as a boot gap", () => {
    const nestedFolder = `${FOLDER}/packages/app`;
    const a = chat("a", nestedFolder, 1);
    hydrate([a], "a");
    const pane = useChatPanesStore
      .getState()
      .splitPane(nestedFolder, MAIN_PANE_ID, "row", null)!;
    useChatPanesStore.getState().beginAssignNextChat(nestedFolder, pane);

    clearChatPaneFolders([FOLDER]);

    expect(useChatPanesStore.getState().byFolder[nestedFolder]).toBeUndefined();
    expect(useChatPanesStore.getState().pendingAssigns).toEqual([]);
  });

  it("bounds the live split-layout owner map", () => {
    const prefix = "/w/bounded-";
    for (let index = 0; index < MAX_PANE_LAYOUT_FOLDERS + 4; index += 1) {
      useChatPanesStore
        .getState()
        .splitPane(`${prefix}${index}`, MAIN_PANE_ID, "row", null);
    }

    const byFolder = useChatPanesStore.getState().byFolder;
    expect(Object.keys(byFolder)).toHaveLength(MAX_PANE_LAYOUT_FOLDERS);
    expect(byFolder[`${prefix}0`]).toBeUndefined();
    expect(byFolder[`${prefix}${MAX_PANE_LAYOUT_FOLDERS + 3}`]).toBeDefined();
  });
});

describe("reservations", () => {
  it("keeps two concurrent reservations separate (FIFO per folder)", () => {
    const a = chat("a", FOLDER, 1);
    hydrate([a], "a");
    const p2 = useChatPanesStore
      .getState()
      .splitPane(FOLDER, MAIN_PANE_ID, "row", null)!;
    useChatPanesStore.getState().beginAssignNextChat(FOLDER, p2);
    const p3 = useChatPanesStore
      .getState()
      .splitPane(FOLDER, MAIN_PANE_ID, "column", null)!;
    useChatPanesStore.getState().beginAssignNextChat(FOLDER, p3);

    dispatch({ type: "ADD_CHAT", chat: chat("b", FOLDER, 2) });
    dispatch({ type: "ADD_CHAT", chat: chat("c", FOLDER, 3) });
    expect(paneForChat(layout(), "b")).toBe(p2);
    expect(paneForChat(layout(), "c")).toBe(p3);
    expect(useChatPanesStore.getState().pendingAssigns).toHaveLength(0);
  });

  it("protects reserved empty panes from collapse until the chat lands", () => {
    const a = chat("a", FOLDER, 1);
    hydrate([a], "a");
    const p2 = useChatPanesStore
      .getState()
      .splitPane(FOLDER, MAIN_PANE_ID, "row", null)!;
    useChatPanesStore.getState().beginAssignNextChat(FOLDER, p2);
    // Unrelated chat mutation while the spawn is in flight — p2 is
    // empty but must survive.
    dispatch({ type: "TOUCH_CHAT", id: "a" });
    expect(leafIds(layout().root)).toEqual([MAIN_PANE_ID, p2]);
  });

  it("keeps a reservation alive past the listAgents request ceiling", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const a = chat("a", FOLDER, 1);
      hydrate([a], "a");
      const p2 = useChatPanesStore
        .getState()
        .splitPane(FOLDER, MAIN_PANE_ID, "row", null)!;
      useChatPanesStore.getState().beginAssignNextChat(FOLDER, p2);

      // The bridge may reject listAgents only after its full 30s timeout.
      // The fallback ADD_CHAT must still find the reservation and preserve
      // the split instead of collapsing p2 before the caller's fallback move.
      now.mockReturnValue(40_001);
      dispatch({ type: "ADD_CHAT", chat: chat("b", FOLDER, 2) });

      expect(leafIds(layout().root)).toEqual([MAIN_PANE_ID, p2]);
      expect(paneForChat(layout(), "b")).toBe(p2);
    } finally {
      now.mockRestore();
    }
  });
});
