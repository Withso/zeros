import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";

// Count dispatches, including React's eager no-op bailouts. Those updates can
// retain their updater closure until the otherwise quiet parent renders again.
const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  writes: vi.fn(), scope: undefined as boolean | undefined,
}));
vi.mock("react", async original => ({
  ...(await original<typeof import("react")>()),
  memo: (component: unknown) => component,
  useContext: () => hooks.scope,
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => [initial, (next: unknown) => hooks.writes(next)],
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
  useLayoutEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
}));

import { CheckpointRail } from "../checkpoint-rail";
import { useStickyBottom } from "../use-sticky-bottom";

const cleanups: Array<() => void> = [];
const resizes = new Set<() => void>();
beforeEach(() => {
  vi.useFakeTimers(); hooks.effects.length = 0; hooks.writes.mockClear();
  hooks.scope = true;
  vi.stubGlobal("window", { setTimeout, clearTimeout, matchMedia: () => ({ matches: true }) });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: () => void) { resizes.add(callback); }
    observe() {}
    disconnect() { resizes.delete(this.callback); }
  });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  expect(resizes.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers(); vi.unstubAllGlobals();
});

function scroller(top = 0) {
  let offset = top;
  const el = Object.assign(new EventTarget(), {
    scrollHeight: 2400, clientHeight: 600, firstElementChild: null,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [0, 1000, 2000].map((position, index) => ({
      dataset: { checkpointId: `prompt-${index}` },
      getBoundingClientRect: () => ({ top: position - offset }),
    })),
    querySelector: (selector: string) => {
      const index = Number(/prompt-(\d+)/.exec(selector)?.[1]);
      return Number.isFinite(index) ? { getBoundingClientRect: () => ({ top: index * 1000 - offset }) } : null;
    },
    scrollTo(options: ScrollToOptions) { el.scrollTop = options.top ?? offset; },
    scrollTop: top,
  });
  Object.defineProperty(el, "scrollTop", {
    get: () => offset,
    set: (value: number) => { offset = Math.max(0, Math.min(value, el.scrollHeight - el.clientHeight)); },
  });
  return el;
}
function commit() {
  for (const effect of hooks.effects.splice(0)) {
    const cleanup = effect(); if (cleanup) cleanups.push(cleanup);
  }
  hooks.writes.mockClear();
}
function grow(el: ReturnType<typeof scroller>, rounds = 100) {
  for (let i = 0; i < rounds; i++) {
    el.scrollHeight += 20;
    for (const resize of resizes) resize();
    vi.advanceTimersByTime(16);
  }
}
function findJump(node: unknown, label: string): (() => void) | undefined {
  if (Array.isArray(node)) return node.map(child => findJump(child, label)).find(Boolean);
  if (!isValidElement<{ "aria-label"?: string; onClick?: () => void; children?: unknown }>(node)) return;
  if (node.props["aria-label"] === label) return node.props.onClick;
  return findJump(node.props.children, label);
}

describe("scroll measurements with an idle React parent", () => {
  it.each(["Personal Local", "organization-local"])("%s follows 100 growth rounds without retaining no-op updaters", () => {
    const el = scroller(1800);
    useStickyBottom(el as unknown as HTMLElement, []); commit();
    grow(el);
    console.info(JSON.stringify({ measurement: "sticky-bottom", rounds: 100, dispatches: hooks.writes.mock.calls.length }));
    expect(el.scrollTop).toBe(el.scrollHeight - el.clientHeight);
    expect(hooks.writes).not.toHaveBeenCalled();
  });

  it("publishes every real reading/latest transition before React rerenders", () => {
    const el = scroller(1800);
    const { jumpToBottom } = useStickyBottom(el as unknown as HTMLElement, []); commit();
    el.scrollTop = 0; el.dispatchEvent(new Event("scroll"));
    grow(el);
    expect(el.scrollTop).toBe(0);
    jumpToBottom(false);
    el.scrollTop = 0; el.dispatchEvent(new Event("scroll"));
    expect(hooks.writes.mock.calls.map(([value]) => typeof value === "function" ? value(true) : value)).toEqual([false, true, false]);
  });

  it("does not mistake a reader gesture at the bottom for changed UI state", () => {
    const el = scroller(1800);
    useStickyBottom(el as unknown as HTMLElement, []); commit();
    el.dispatchEvent(new Event("wheel")); vi.advanceTimersByTime(16);
    grow(el);
    expect(hooks.writes).not.toHaveBeenCalled();
    expect(el.scrollTop).toBe(el.scrollHeight - el.clientHeight);
  });

  it.each(["Personal Local", "organization-local"])("%s checkpoint measurements dispatch only a changed region", () => {
    const el = scroller();
    const recomputeRef = { current: null as (() => void) | null };
    CheckpointRail({ scrollEl: el as unknown as HTMLElement,
      checkpoints: [0, 1, 2].map(index => ({ id: `prompt-${index}`, text: `Prompt ${index}` })),
      bottomSpacerPx: 0, onBottomSpacerChange: vi.fn(), recomputeRef });
    commit(); grow(el);
    console.info(JSON.stringify({ measurement: "checkpoint", rounds: 100, dispatches: hooks.writes.mock.calls.length }));
    expect(hooks.writes).not.toHaveBeenCalled();
    el.scrollTop = 1000; recomputeRef.current!();
    grow(el); el.scrollTop = 0; recomputeRef.current!(); grow(el);
    expect(hooks.writes.mock.calls.map(([value]) => typeof value === "function" ? value(0) : value)).toEqual([1, 0]);
  });

  it("preserves default/cloud measurement dispatches", () => {
    hooks.scope = undefined;
    const el = scroller(1800);
    useStickyBottom(el as unknown as HTMLElement, []); commit(); grow(el);
    expect(hooks.writes).toHaveBeenCalledTimes(100);
  });

  it("remembers a clicked checkpoint while measurements run before another render", () => {
    const el = scroller();
    const tree = CheckpointRail({ scrollEl: el as unknown as HTMLElement,
      checkpoints: [0, 1, 2].map(index => ({ id: `prompt-${index}`, text: `Prompt ${index}` })),
      bottomSpacerPx: 0, onBottomSpacerChange: vi.fn() });
    commit(); findJump(tree, "Jump to: Prompt 1")!(); grow(el);
    expect(hooks.writes).toHaveBeenCalledTimes(1);
    expect(hooks.writes).toHaveBeenLastCalledWith(1);
    el.dispatchEvent(new Event("wheel")); el.scrollTop = 0; grow(el);
    expect(hooks.writes.mock.calls.map(([value]) => typeof value === "function" ? value(0) : value)).toEqual([1, 0]);
  });

  it("preserves default/cloud checkpoint dispatches", () => {
    hooks.scope = undefined;
    const el = scroller();
    CheckpointRail({ scrollEl: el as unknown as HTMLElement,
      checkpoints: [0, 1].map(index => ({ id: `prompt-${index}`, text: `Prompt ${index}` })),
      bottomSpacerPx: 0, onBottomSpacerChange: vi.fn() });
    commit(); grow(el);
    expect(hooks.writes).toHaveBeenCalledTimes(100);
  });
});
