import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORED_PROGRESS_MS, watchStoredProgress } from "../cloud-stored-progress";

// Without the live connection a running turn's whole items still reach the server's stored history (the worker
// mirrors them outbound). The active chat re-reads that history on a bounded clock until the turn ends or live returns.
function harness() {
  const state = { chat: "chat-a" as string | null, connected: false, visible: true };
  const listeners = new Set<() => void>();
  const reread = vi.fn();
  const stop = watchStoredProgress({
    runningChat: () => state.chat, liveConnected: () => state.connected, visible: () => state.visible, reread,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  });
  const changed = (patch: Partial<typeof state>) => { Object.assign(state, patch); for (const listener of listeners) listener(); };
  return { reread, changed, stop, listeners };
}

describe("stored progress while the live connection is unavailable", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-reads the running chat every 5 s, never sooner, and stops when the turn ends", () => {
    const h = harness();
    expect(STORED_PROGRESS_MS).toBe(5_000);
    vi.advanceTimersByTime(4_999); expect(h.reread).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(h.reread).toHaveBeenLastCalledWith("chat-a");
    // Store churn (stream chunks, other chats) does not restart or add clocks.
    for (let i = 0; i < 20; i++) h.changed({});
    vi.advanceTimersByTime(5_000); expect(h.reread).toHaveBeenCalledTimes(2);
    h.changed({ chat: null });
    vi.advanceTimersByTime(60_000); expect(h.reread).toHaveBeenCalledTimes(2);
  });

  it("reads nothing while live is connected, while hidden, or after stop; a switched chat gets its own clock", () => {
    const h = harness();
    h.changed({ connected: true }); vi.advanceTimersByTime(30_000); expect(h.reread).not.toHaveBeenCalled();
    h.changed({ connected: false, visible: false }); vi.advanceTimersByTime(30_000); expect(h.reread).not.toHaveBeenCalled();
    h.changed({ visible: true, chat: "chat-b" }); vi.advanceTimersByTime(5_000); expect(h.reread).toHaveBeenLastCalledWith("chat-b");
    h.stop(); vi.advanceTimersByTime(60_000); expect(h.reread).toHaveBeenCalledTimes(1); expect(h.listeners.size).toBe(0);
  });

  it("a tick that finds live connected again skips the read and disarms", () => {
    const state = { connected: false };
    const reread = vi.fn();
    watchStoredProgress({ runningChat: () => "chat-a", liveConnected: () => state.connected, visible: () => true, reread, subscribe: () => () => {} });
    state.connected = true;
    vi.advanceTimersByTime(30_000);
    expect(reread).not.toHaveBeenCalled();
  });
});
