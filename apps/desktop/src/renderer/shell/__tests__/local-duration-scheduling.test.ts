import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, changed: vi.fn(),
  host: null as unknown as HTMLElement }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
  useRef: (initial: unknown) => ({ current: initial === null ? hooks.host : initial }),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, hooks.changed],
}));
import { ActivityScope } from "../../shared/ui/loading/activity-scope";
import { LiveDuration, WorkingDuration } from "../../shared/ui/loading/live-duration";

let page: EventTarget & { visibilityState: string; hasFocus: () => boolean };
let win: EventTarget;
let focused: boolean, visible: boolean;
const cleanups: Array<() => void> = [];
function mount(kind: "live" | "working", scope: boolean | undefined, startedAt = 0) {
  hooks.effects.length = 0;
  renderToStaticMarkup(createElement(ActivityScope.Provider, { value: scope },
    createElement(kind === "live" ? LiveDuration : WorkingDuration, { startedAt })));
  for (const effect of hooks.effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(5_400_000); focused = true; visible = true;
  page = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  win = Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16),
    cancelAnimationFrame: clearTimeout });
  hooks.host = { checkVisibility: () => visible, parentElement: null, style: {} } as unknown as HTMLElement;
  vi.stubGlobal("window", win); vi.stubGlobal("document", page);
  hooks.changed.mockClear();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("Local display deadlines", () => {
  it("updates three long-running rows only when their displayed minute changes", () => {
    for (let row = 0; row < 3; row++) mount("live", true);
    hooks.changed.mockClear();
    vi.advanceTimersByTime(30_000);
    console.info(JSON.stringify({ rows: 3, elapsedMs: 30_000, stateUpdates: hooks.changed.mock.calls.length }));
    expect(hooks.changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(hooks.changed).toHaveBeenCalledTimes(3);
  });

  it("ticks the working label at its exact tenths, without a frame loop", () => {
    mount("working", true, Date.now()); hooks.changed.mockClear();
    vi.advanceTimersByTime(1_000);
    console.info(JSON.stringify({ elapsedMs: 1_000, workingUpdates: hooks.changed.mock.calls.length }));
    expect(hooks.changed).toHaveBeenCalledTimes(10);
    expect(hooks.changed).toHaveBeenLastCalledWith("1.0s");
  });

  it.each(["hidden", "blurred", "offscreen", "retained"])("owns zero timers while %s", (mode) => {
    if (mode === "hidden") page.visibilityState = "hidden";
    if (mode === "blurred") focused = false;
    if (mode === "offscreen") visible = false;
    mount("live", mode !== "retained"); mount("working", mode !== "retained");
    expect(vi.getTimerCount()).toBe(0);
    hooks.changed.mockClear(); vi.advanceTimersByTime(60_000);
    expect(hooks.changed).not.toHaveBeenCalled();
  });

  it("disarms on blur and catches up immediately on focus", () => {
    mount("live", true, Date.now()); hooks.changed.mockClear();
    focused = false; win.dispatchEvent(new Event("blur"));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(hooks.changed).not.toHaveBeenCalled();
    focused = true; win.dispatchEvent(new Event("focus"));
    expect(hooks.changed).toHaveBeenLastCalledWith("10s");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("preserves the default/cloud one-second cadence", () => {
    for (let row = 0; row < 3; row++) mount("live", undefined);
    hooks.changed.mockClear(); vi.advanceTimersByTime(30_000);
    expect(hooks.changed).toHaveBeenCalledTimes(90);
    expect(vi.getTimerCount()).toBe(3);
  });
});
