import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_UPDATE_FLUSH_DEADLINE_MS,
  createAgentUpdateFlushScheduler,
  type AgentUpdateFlushScheduler,
} from "../agent-update-flush-scheduler";

// Frames are explicit: a hidden, minimized or occluded window never runs them.
function frames() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    request: vi.fn((callback: () => void) => {
      const handle = next++;
      pending.set(handle, callback);
      return handle;
    }),
    cancel: vi.fn((handle: number) => {
      pending.delete(handle);
    }),
    run() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    get size() {
      return pending.size;
    },
  };
}

function scheduler(flush: (api: AgentUpdateFlushScheduler) => void) {
  const frame = frames();
  const api: AgentUpdateFlushScheduler = createAgentUpdateFlushScheduler(() => flush(api), {
    requestFrame: frame.request,
    cancelFrame: frame.cancel,
  });
  return { frame, api };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("agent update flush scheduling", () => {
  it("coalesces requests into one frame-aligned flush and clears the deadline", () => {
    const flush = vi.fn();
    const { frame, api } = scheduler(flush);
    api.schedule();
    api.schedule();
    api.schedule();
    expect(frame.request).toHaveBeenCalledOnce();
    expect(flush).not.toHaveBeenCalled();
    frame.run();
    expect(flush).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(AGENT_UPDATE_FLUSH_DEADLINE_MS * 4);
    expect(flush).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains by the deadline when no frame arrives and drops the stale frame", () => {
    const flush = vi.fn();
    const { frame, api } = scheduler(flush);
    api.schedule();
    vi.advanceTimersByTime(AGENT_UPDATE_FLUSH_DEADLINE_MS - 1);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledOnce();
    expect(frame.size).toBe(0);
    // A window that becomes visible again starts frame-aligned work afresh.
    api.schedule();
    frame.run();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a frame-aligned deadline below one second", () => {
    expect(AGENT_UPDATE_FLUSH_DEADLINE_MS).toBeGreaterThan(1000 / 30);
    expect(AGENT_UPDATE_FLUSH_DEADLINE_MS).toBeLessThan(1000);
  });

  it("drains synchronously on demand and cancels pending callbacks", () => {
    const flush = vi.fn();
    const { frame, api } = scheduler(flush);
    api.schedule();
    api.flushNow();
    expect(flush).toHaveBeenCalledOnce();
    expect(frame.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    frame.run();
    vi.runAllTimers();
    expect(flush).toHaveBeenCalledOnce();
  });

  it("runs a drain requested during a flush right after it, never inside it", () => {
    const order: string[] = [];
    let depth = 0;
    const flush = vi.fn((api: AgentUpdateFlushScheduler) => {
      depth += 1;
      order.push(`flush ${flush.mock.calls.length} depth ${depth}`);
      if (flush.mock.calls.length === 1) {
        api.flushNow();
        order.push("requested");
      }
      depth -= 1;
    });
    const { api } = scheduler(flush);
    api.flushNow();
    expect(order).toEqual(["flush 1 depth 1", "requested", "flush 2 depth 1"]);
  });

  it("schedules a frame for work buffered during a flush", () => {
    const flush = vi.fn((api: AgentUpdateFlushScheduler) => {
      if (flush.mock.calls.length === 1) api.schedule();
    });
    const created = scheduler(flush);
    created.api.flushNow();
    expect(flush).toHaveBeenCalledOnce();
    expect(created.frame.size).toBe(1);
    created.frame.run();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("re-arms a pending drain when a flush throws", () => {
    const flush = vi.fn((api: AgentUpdateFlushScheduler) => {
      if (flush.mock.calls.length === 1) {
        api.flushNow();
        throw new Error("reducer failed");
      }
    });
    const created = scheduler(flush);
    const { api } = created;
    expect(() => api.flushNow()).toThrow("reducer failed");
    expect(created.frame.size).toBe(1);
    created.frame.run();
    expect(flush).toHaveBeenCalledTimes(2);
    // The scheduler is usable after the failure.
    api.flushNow();
    expect(flush).toHaveBeenCalledTimes(3);
  });

  it("drains armed work on dispose and never parks later requests", () => {
    const flush = vi.fn();
    const { frame, api } = scheduler(flush);
    api.dispose();
    expect(flush).not.toHaveBeenCalled();
    api.schedule();
    expect(flush).toHaveBeenCalledOnce();
    expect(frame.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    const second = scheduler(vi.fn());
    second.api.schedule();
    second.api.dispose();
    expect(second.frame.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the renderer's own frame and timer functions by default", () => {
    const request = vi.fn((_callback: FrameRequestCallback) => 7);
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", request);
    vi.stubGlobal("cancelAnimationFrame", cancel);
    try {
      const flush = vi.fn();
      const api = createAgentUpdateFlushScheduler(flush);
      api.schedule();
      expect(request).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(AGENT_UPDATE_FLUSH_DEADLINE_MS);
      expect(flush).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledWith(7);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
