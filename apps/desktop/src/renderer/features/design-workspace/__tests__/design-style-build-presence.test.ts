import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DESIGN_STYLE_BUILD_HEARTBEAT_MS,
  startDesignStyleBuildPresence,
} from "../state/use-design-style-build-presence";

function visibility(initial: DocumentVisibilityState) {
  const listeners = new Set<() => void>();
  return {
    visibilityState: initial,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    set(next: DocumentVisibilityState) {
      this.visibilityState = next;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

describe("Design style build presence", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports at once, repeats while visible, and reports leaving when hidden or closed", () => {
    const report = vi.fn(async () => {});
    const target = visibility("visible");
    const stop = startDesignStyleBuildPresence("ws", report, target as unknown as Document);
    expect(report.mock.calls).toEqual([["ws", true]]);
    vi.advanceTimersByTime(DESIGN_STYLE_BUILD_HEARTBEAT_MS);
    expect(report.mock.calls).toEqual([["ws", true], ["ws", true]]);
    target.set("hidden");
    expect(report.mock.calls.at(-1)).toEqual(["ws", false]);
    vi.advanceTimersByTime(DESIGN_STYLE_BUILD_HEARTBEAT_MS * 3);
    expect(report).toHaveBeenCalledTimes(3);
    target.set("visible");
    expect(report.mock.calls.at(-1)).toEqual(["ws", true]);
    stop();
    expect(report.mock.calls.at(-1)).toEqual(["ws", false]);
    expect(target.listeners.size).toBe(0);
    vi.advanceTimersByTime(DESIGN_STYLE_BUILD_HEARTBEAT_MS * 3);
    expect(report).toHaveBeenCalledTimes(5);
  });

  it("stays silent while a hidden tab never shows, and ignores refusals", () => {
    const report = vi.fn(async () => {
      throw new Error("refused for this role");
    });
    const target = visibility("hidden");
    const stop = startDesignStyleBuildPresence("ws", report, target as unknown as Document);
    vi.advanceTimersByTime(DESIGN_STYLE_BUILD_HEARTBEAT_MS * 2);
    stop();
    expect(report).not.toHaveBeenCalled();
  });
});
