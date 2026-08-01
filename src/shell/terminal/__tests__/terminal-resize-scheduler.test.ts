import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginContinuousLayoutResize,
  resetContinuousLayoutResizeForTests,
} from "../continuous-layout-resize";
import {
  TERMINAL_RESIZE_SETTLE_MS,
  createTerminalResizeScheduler,
} from "../terminal-resize-scheduler";

describe("terminal resize scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetContinuousLayoutResizeForTests();
    vi.useRealTimers();
  });

  function createHarness(run: () => void) {
    let nextFrameId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const scheduler = createTerminalResizeScheduler(run, {
      requestFrame(callback) {
        const id = nextFrameId++;
        frames.set(id, callback);
        return id;
      },
      cancelFrame(id) {
        frames.delete(id);
      },
    });
    const paint = () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(performance.now());
    };
    return { scheduler, paint, frames };
  }

  it("collapses a continuous native-window resize burst into one settled fit", () => {
    const run = vi.fn();
    const { scheduler, paint, frames } = createHarness(run);

    scheduler.request();
    vi.advanceTimersByTime(TERMINAL_RESIZE_SETTLE_MS - 1);
    scheduler.request();
    vi.advanceTimersByTime(TERMINAL_RESIZE_SETTLE_MS - 1);
    expect(frames.size).toBe(0);
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(frames.size).toBe(1);
    paint();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does no xterm work during a known pane drag and fits once on release", () => {
    const run = vi.fn();
    const { scheduler, paint, frames } = createHarness(run);
    const finish = beginContinuousLayoutResize();

    scheduler.request();
    scheduler.request();
    vi.advanceTimersByTime(TERMINAL_RESIZE_SETTLE_MS * 4);
    paint();
    expect(run).not.toHaveBeenCalled();

    finish();
    expect(frames.size).toBe(1);
    paint();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancels a queued fit when a drag begins, then resumes with one fit", () => {
    const run = vi.fn();
    const { scheduler, paint, frames } = createHarness(run);

    scheduler.request();
    vi.advanceTimersByTime(TERMINAL_RESIZE_SETTLE_MS);
    expect(frames.size).toBe(1);

    const finish = beginContinuousLayoutResize();
    expect(frames.size).toBe(0);
    paint();
    expect(run).not.toHaveBeenCalled();

    finish();
    paint();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("flushes on the next frame without the native-window settle delay", () => {
    const run = vi.fn();
    const { scheduler, paint, frames } = createHarness(run);

    scheduler.flush();
    expect(frames.size).toBe(1);
    expect(run).not.toHaveBeenCalled();

    paint();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit flush dirty until an active drag releases", () => {
    const run = vi.fn();
    const { scheduler, paint, frames } = createHarness(run);
    const finish = beginContinuousLayoutResize();

    scheduler.flush();
    expect(frames.size).toBe(0);
    paint();
    expect(run).not.toHaveBeenCalled();

    finish();
    expect(frames.size).toBe(1);
    paint();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("disposal cancels timers, frames, and coordinator subscriptions", () => {
    const run = vi.fn();
    const { scheduler, paint, frames } = createHarness(run);

    scheduler.request();
    scheduler.dispose();
    vi.advanceTimersByTime(TERMINAL_RESIZE_SETTLE_MS);
    paint();
    expect(frames.size).toBe(0);
    expect(run).not.toHaveBeenCalled();

    const finish = beginContinuousLayoutResize();
    finish();
    paint();
    expect(run).not.toHaveBeenCalled();
  });
});
