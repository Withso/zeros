import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatThread } from "../store";
import { useWorkspaceStore } from "../workspace-store";
import { reconcileChatSnapshot } from "../chat-reconciliation";

beforeAll(() => {
  vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {} });
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});
afterEach(() => { vi.restoreAllMocks(); useWorkspaceStore.setState(useWorkspaceStore.getInitialState()); });

const placements = [
  ["Local", "/personal/project"],
  ["organization-local", "/organization/project"],
  ["cloud", "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222"],
] as const;
const chat = (id: string, folder: string, updatedAt: number): ChatThread => ({
  id, folder, title: id, createdAt: 10, updatedAt,
  agentId: "claude", agentName: "Claude", model: null, effort: "high", permissionMode: "auto",
});

describe.each(placements)("optimistic tab close in %s", (_placement, folder) => {
  it.each([1_000, 2_000])("survives a delayed pre-close snapshot with revision %i", updatedAt => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const closing = chat("closing", folder, updatedAt), sibling = chat("sibling", folder, 500);
    const remote = [closing, sibling];
    useWorkspaceStore.setState({ chats: remote, activeChatId: closing.id, activePage: "workspace" });
    useWorkspaceStore.getState().dispatch({ type: "ARCHIVE_CHAT", id: closing.id });
    const optimistic = useWorkspaceStore.getState();
    expect(optimistic.chats[0].archived).toBe(true);
    expect(optimistic.activeChatId).toBe(sibling.id);

    // The server read started before the close; the asynchronous archive write
    // is still held. A stale read must not put the tab back in the open strip.
    const revalidated = reconcileChatSnapshot(optimistic.chats, remote, [], [folder]);
    expect(revalidated.chats[0].archived).toBe(true);
    expect(revalidated.chats).toBe(optimistic.chats);
    expect(revalidated.rowsToPush).toEqual([optimistic.chats[0]]);
    expect(revalidated.chats[0].updatedAt).toBeGreaterThan(updatedAt);
    expect(revalidated.chats[1]).toBe(sibling);
    // A confirmed archive makes write-through quiescent.
    expect(reconcileChatSnapshot(revalidated.chats, revalidated.chats, [], [folder]).rowsToPush).toEqual([]);
  });

  it("keeps close/reopen ordering even when the device clock is behind the saved chat", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const target = chat("target", folder, 2_000), sibling = chat("sibling", folder, 500);
    useWorkspaceStore.setState({ chats: [target, sibling], activeChatId: target.id });
    const dispatch = useWorkspaceStore.getState().dispatch;
    dispatch({ type: "ARCHIVE_CHAT", id: target.id });
    const closed = useWorkspaceStore.getState().chats;
    dispatch({ type: "UNARCHIVE_CHAT", id: target.id });
    const reopened = useWorkspaceStore.getState().chats;
    expect(reopened[0].updatedAt).toBeGreaterThan(closed[0].updatedAt);
    expect(reconcileChatSnapshot(reopened, closed, [], [folder]).chats[0].archived).toBe(false);
    // This is local recency, not authority to ignore a durable deletion.
    expect(reconcileChatSnapshot(reopened, [sibling], [target.id], [folder]).chats).toEqual([sibling]);
  });
});


describe.each(placements)("ARCH independent close boundaries in %s", (_placement, folder) => {
  it("preserves idempotence, sibling references and a genuinely newer remote edit", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const target = chat("target", folder, 2_000), sibling = chat("sibling", folder, 500);
    useWorkspaceStore.setState({ chats: [target, sibling], activeChatId: sibling.id });
    const dispatch = useWorkspaceStore.getState().dispatch;
    dispatch({ type: "ARCHIVE_CHAT", id: target.id });
    const closed = useWorkspaceStore.getState();
    dispatch({ type: "ARCHIVE_CHAT", id: target.id });
    expect(useWorkspaceStore.getState()).toBe(closed);
    expect(closed.activeChatId).toBe(sibling.id);
    expect(closed.chats[1]).toBe(sibling);
    const newer = { ...closed.chats[0], updatedAt: closed.chats[0].updatedAt + 1, archived: false };
    const result = reconcileChatSnapshot(closed.chats, [newer, sibling], [], [folder]);
    expect(result.chats[0]).toBe(newer);
    expect(result.rowsToPush).toEqual([]);
  });

  it("does not publish an unconfirmed owner's optimistic close", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const target = chat("target", folder, 2_000);
    useWorkspaceStore.setState({ chats: [target], activeChatId: target.id });
    useWorkspaceStore.getState().dispatch({ type: "ARCHIVE_CHAT", id: target.id });
    const closed = useWorkspaceStore.getState().chats;
    const result = reconcileChatSnapshot(closed, [target], [target.id], [], false);
    expect(result.chats).toBe(closed);
    expect(result.rowsToPush).toEqual([]);
    expect(result.removedIds).toEqual([]);
  });

  it("keeps engine-owned composer revision when it retains an optimistic close", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const target = chat("target", folder, 2_000);
    useWorkspaceStore.setState({ chats: [target], activeChatId: target.id });
    useWorkspaceStore.getState().dispatch({ type: "ARCHIVE_CHAT", id: target.id });
    const closed = useWorkspaceStore.getState().chats;
    const result = reconcileChatSnapshot(closed, [{ ...target, composerMode: "design", composerModeRevision: 5 }], [], [folder]);
    expect(result.chats[0]).toMatchObject({ archived: true, composerMode: "design", composerModeRevision: 5 });
  });

  it.each(["UPDATE_CHAT_TITLE", "UPDATE_CHAT_TITLE_IF"] as const)(
    "retains the close revision through a late %s before the held snapshot returns", type => {
      vi.spyOn(Date, "now").mockReturnValue(1_000);
      const target = chat("target", folder, 2_000), sibling = chat("sibling", folder, 500);
      const held = [target, sibling];
      useWorkspaceStore.setState({ chats: held, activeChatId: target.id });
      const dispatch = useWorkspaceStore.getState().dispatch;
      dispatch({ type: "ARCHIVE_CHAT", id: target.id });
      dispatch(type === "UPDATE_CHAT_TITLE"
        ? { type, id: target.id, title: "Generated title" }
        : { type, id: target.id, expectedTitle: target.title, title: "Generated title" });
      const optimistic = useWorkspaceStore.getState().chats;
      expect(optimistic[0].archived).toBe(true);
      expect(reconcileChatSnapshot(optimistic, held, [], [folder]).chats[0].archived).toBe(true);
    },
  );
});

// Session/config callbacks can also settle after an optimistic tab close.
describe.each(placements)("late metadata after close in %s", (_placement, folder) => {
  it.each(["UPDATE_CHAT_SETTINGS", "TOUCH_CHAT"] as const)("preserves the close revision through %s", type => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const target = chat("target", folder, 2_000);
    useWorkspaceStore.setState({ chats: [target], activeChatId: target.id });
    const dispatch = useWorkspaceStore.getState().dispatch;
    dispatch({ type: "ARCHIVE_CHAT", id: target.id });
    const closeRevision = useWorkspaceStore.getState().chats[0].updatedAt;
    dispatch(type === "UPDATE_CHAT_SETTINGS" ? { type, id: target.id, updates: { model: "fixture-model" } } : { type, id: target.id });
    const current = useWorkspaceStore.getState().chats;
    expect(current[0].updatedAt).toBeGreaterThan(closeRevision);
    expect(reconcileChatSnapshot(current, [target], [], [folder]).chats[0].archived).toBe(true);
  });

  it("keeps pin/mode edits monotonic and refuses a superseded conditional title", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const target = chat("target", folder, 2_000);
    useWorkspaceStore.setState({ chats: [target], activeChatId: target.id });
    const dispatch = useWorkspaceStore.getState().dispatch;
    dispatch({ type: "ARCHIVE_CHAT", id: target.id });
    const closeRevision = useWorkspaceStore.getState().chats[0].updatedAt;
    dispatch({ type: "TOGGLE_PIN_CHAT", id: target.id });
    dispatch({ type: "SET_CHAT_COMPOSER_MODE", id: target.id, folder, mode: "design", revision: 4 });
    dispatch({ type: "UPDATE_CHAT_TITLE_IF", id: target.id, expectedTitle: "stale-title", title: "Unexpected" });
    const current = useWorkspaceStore.getState().chats;
    expect(current[0]).toMatchObject({ archived: true, title: target.title, updatedAt: closeRevision, composerMode: "design", composerModeRevision: 4 });
    expect(reconcileChatSnapshot(current, [target], [], [folder]).chats[0].archived).toBe(true);
  });
});
