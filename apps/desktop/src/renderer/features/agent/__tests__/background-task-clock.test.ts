import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the actual consumer and its subscriptions without a DOM renderer.
// Each mount commits its captured effects; timer and visibility ownership stay real.
const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  changed: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => {
    hooks.effects.push(effect);
  },
  useState: (initial: unknown) => [
    typeof initial === "function" ? initial() : initial,
    hooks.changed,
  ],
  useSyncExternalStore: (
    subscribe: (listener: () => void) => () => void,
    snapshot: () => number,
  ) => {
    hooks.effects.push(() => subscribe(() => hooks.changed()));
    return snapshot();
  },
}));
vi.mock("@/renderer/shared/ui/loading", async (original) => ({
  ...(await original<typeof import("@/renderer/shared/ui/loading")>()),
  ZerosSpinner: () => null,
}));

import { BackgroundTasksWaitingLine } from "../background-task-activity";
import type { BackgroundTask } from "../../../platform/bridge/agent-events";

let page: EventTarget & { visibilityState: string };
const disposers: Array<() => void> = [];
const tasks: BackgroundTask[] = [
  { taskId: "task", name: "Waiting task", startedAt: 0, updatedAt: 0 },
];

function render(startedAt: number, active = true, pending = tasks) {
  return renderToStaticMarkup(
    createElement(BackgroundTasksWaitingLine, { tasks: pending, startedAt, active }),
  );
}
function mount(startedAt = Date.now(), active = true, pending = tasks) {
  hooks.effects.length = 0;
  render(startedAt, active, pending);
  const cleanups = hooks.effects.splice(0).map((effect) => effect());
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups) cleanup?.();
  };
  disposers.push(dispose);
  return dispose;
}
function visibility(value: "visible" | "hidden") {
  page.visibilityState = value;
  page.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", globalThis);
  hooks.changed.mockClear();
  hooks.effects.length = 0;
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  hooks.effects.length = 0;
});

describe("background task display clock", () => {
  it("owns no timer when a mounted active chat's window starts hidden", () => {
    page.visibilityState = "hidden";
    mount();
    expect(vi.getTimerCount()).toBe(0);
    hooks.changed.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(hooks.changed).not.toHaveBeenCalled();
  });

  it("removes the display timer on hide and catches up immediately on reveal", () => {
    const startedAt = Date.now();
    mount(startedAt);
    vi.advanceTimersByTime(2_000);
    visibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    hooks.changed.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(hooks.changed).not.toHaveBeenCalled();
    visibility("visible");
    expect(hooks.changed).toHaveBeenCalled();
    expect(render(startedAt)).toContain("1m 2s");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("shares one visible timer across mounted chats and releases the final owner", () => {
    const first = mount();
    const second = mount(Date.now() - 10_000);
    expect(vi.getTimerCount()).toBe(1);
    hooks.changed.mockClear();
    vi.advanceTimersByTime(1_000);
    expect(hooks.changed).toHaveBeenCalledTimes(2);
    first();
    expect(vi.getTimerCount()).toBe(1);
    second();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops at the live document gate if the visibility event arrives late", () => {
    mount();
    page.visibilityState = "hidden";
    hooks.changed.mockClear();
    vi.advanceTimersByTime(1_000);
    expect(hooks.changed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    visibility("hidden");
    visibility("visible");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("leaves inactive or settled chats without a clock", () => {
    mount(Date.now(), false);
    mount(Date.now(), true, []);
    expect(vi.getTimerCount()).toBe(0);
    expect(render(Date.now(), false)).toBe("");
    expect(render(Date.now(), true, [])).toBe("");
  });

  it("uses each Local or cloud chat's absolute start across A to B to A", () => {
    const a = Date.now() - 30_000;
    const b = Date.now() - 5_000;
    const offA = mount(a);
    expect(render(a)).toContain("30s");
    offA();
    const offB = mount(b);
    vi.advanceTimersByTime(2_000);
    expect(render(b)).toContain("7s");
    offB();
    mount(a);
    expect(render(a)).toContain("32s");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not leave a reveal listener or timer after the last chat unmounts", () => {
    const dispose = mount();
    visibility("hidden");
    dispose();
    hooks.changed.mockClear();
    visibility("visible");
    vi.advanceTimersByTime(5_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(hooks.changed).not.toHaveBeenCalled();
    mount();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not let an uncommitted snapshot read consume another chat's next tick", () => {
    const startedAt = Date.now();
    mount(startedAt);
    hooks.changed.mockClear();
    vi.setSystemTime(Date.now() + 20_000);
    render(startedAt);
    expect(hooks.changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(hooks.changed).toHaveBeenCalledOnce();
    expect(render(startedAt)).toContain("21s");
  });

  it("does not postpone the visible tick when another consumer mounts", () => {
    mount();
    vi.advanceTimersByTime(600);
    mount();
    visibility("visible");
    hooks.changed.mockClear();
    vi.advanceTimersByTime(400);
    expect(hooks.changed).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });
});
