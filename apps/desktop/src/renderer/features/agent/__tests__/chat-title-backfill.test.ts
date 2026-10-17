// Untitled Local chats get named even when nobody opens them: chats an agent
// started or messaged, tabs left in the background, chats reloaded with a long
// history. The engine says which prompt names each chat.

import { afterEach, describe, expect, it, vi } from "vitest";
import { startChatTitleBackfill, type ChatTitleBackfillDeps } from "../chat-title-backfill";

type Chat = { id: string; title: string; folder: string; archived?: boolean; kind?: string | null; updatedAt: number };

function harness(chats: Chat[]) {
  let list = chats;
  const listeners = new Set<() => void>();
  const dbListeners = new Set<(message: unknown) => void>();
  const request = vi.fn<ChatTitleBackfillDeps["request"]>().mockReturnValue(true);
  const seeds = vi.fn<ChatTitleBackfillDeps["seeds"]>().mockImplementation(async (ids) =>
    ids.map((chatId) => ({ chatId, messageId: `m-${chatId}`, prompt: `Prompt for ${chatId}`, answered: true })));
  const deps: ChatTitleBackfillDeps = {
    getChats: () => list as never,
    subscribeChats: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onDbChanged: (listener) => {
      dbListeners.add(listener);
      return () => dbListeners.delete(listener);
    },
    connected: () => true,
    seeds,
    request,
    dispatch: vi.fn(),
    now: () => 1_000_000_000,
  };
  return {
    deps,
    seeds,
    request,
    setChats(next: Chat[]) {
      list = next;
      for (const listener of listeners) listener();
    },
    dbChanged(message: unknown) {
      for (const listener of dbListeners) listener(message);
    },
  };
}

const now = 1_000_000_000;
afterEach(() => vi.useRealTimers());

describe("Untitled chat backfill", () => {
  it("names every Untitled or New chat Local chat the agent answered, open or not", async () => {
    vi.useFakeTimers();
    const h = harness([
      { id: "a", title: "Untitled", folder: "/repo", updatedAt: now },
      { id: "b", title: "New chat", folder: "/repo", updatedAt: now },
      { id: "named", title: "Fix login", folder: "/repo", updatedAt: now },
      { id: "gone", title: "Untitled", folder: "/repo", archived: true, updatedAt: now },
      { id: "term", title: "Untitled", folder: "/repo", kind: "terminal", updatedAt: now },
      { id: "cloud", title: "Untitled", folder: "cloud://org/ws", updatedAt: now },
      { id: "old", title: "Untitled", folder: "/repo", updatedAt: now - 30 * 24 * 3_600_000 },
    ]);
    const stop = startChatTitleBackfill(h.deps);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.seeds).toHaveBeenCalledOnce();
    expect([...h.seeds.mock.calls[0]![0]].sort()).toEqual(["a", "b"]);
    expect(h.request.mock.calls.map(([args]) => [args.chatId, args.messageId, args.expectedTitle])).toEqual([
      ["a", "m-a", "Untitled"],
      ["b", "m-b", "New chat"],
    ]);
    stop();
  });

  it("waits for an answer, then tries again when that chat's transcript changes", async () => {
    vi.useFakeTimers();
    const h = harness([{ id: "a", title: "Untitled", folder: "/repo", updatedAt: now }]);
    h.seeds.mockResolvedValueOnce([{ chatId: "a", messageId: "m-a", prompt: "Hi", answered: false }]);
    const stop = startChatTitleBackfill(h.deps);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.request).not.toHaveBeenCalled();
    h.dbChanged({ type: "DB_CHANGED", kinds: ["messages"], chatIds: ["other"] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.seeds).toHaveBeenCalledOnce();
    h.dbChanged({ type: "DB_CHANGED", kinds: ["messages"], chatIds: ["a"] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.request).toHaveBeenCalledOnce();
    stop();
  });

  it("picks up a chat that becomes Untitled-and-answered later and never after a rename", async () => {
    vi.useFakeTimers();
    const h = harness([]);
    const stop = startChatTitleBackfill(h.deps);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.seeds).not.toHaveBeenCalled();
    h.setChats([{ id: "n", title: "New chat", folder: "/repo", updatedAt: now }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.request).toHaveBeenCalledOnce();
    h.setChats([{ id: "n", title: "Renamed", folder: "/repo", updatedAt: now }]);
    h.dbChanged({ type: "DB_CHANGED", kinds: ["messages"], chatIds: ["n"] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.seeds).toHaveBeenCalledOnce();
    stop();
  });

  it("spreads a backlog of Untitled chats out instead of bursting past the rate limit", async () => {
    vi.useFakeTimers();
    let clock = now;
    const h = harness(Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, title: "Untitled", folder: "/repo", updatedAt: now })));
    h.deps.now = () => clock;
    const stop = startChatTitleBackfill(h.deps);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.request).toHaveBeenCalledTimes(6);
    clock += 31_000;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(h.request).toHaveBeenCalledTimes(10);
    stop();
  });

  it("stays quiet while the engine is unreachable and stops cleanly", async () => {
    vi.useFakeTimers();
    const h = harness([{ id: "a", title: "Untitled", folder: "/repo", updatedAt: now }]);
    let connected = false;
    h.deps.connected = () => connected;
    const stop = startChatTitleBackfill(h.deps);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.seeds).not.toHaveBeenCalled();
    connected = true;
    h.dbChanged({ type: "DB_CHANGED", kinds: ["chats"] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.seeds).toHaveBeenCalledOnce();
    stop();
    h.dbChanged({ type: "DB_CHANGED", kinds: ["messages"], chatIds: ["a"] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.seeds).toHaveBeenCalledOnce();
  });
});
