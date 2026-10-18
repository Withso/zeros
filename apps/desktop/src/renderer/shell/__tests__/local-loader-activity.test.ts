import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLoaderRun } from "../../shared/ui/loading/loader-loop";

let page: EventTarget & { visibilityState: string; hasFocus: () => boolean };
let win: EventTarget;
let focused: boolean;
let frameId: number;
const frames = new Map<number, FrameRequestCallback>();
const cleanups: Array<() => void> = [];
let intersection: IntersectionObserverCallback;

beforeEach(() => {
  frameId = 0; focused = true; frames.clear();
  page = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  win = Object.assign(new EventTarget(), {
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", page);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersection = callback; }
    observe() {} unobserve() {} disconnect() {}
  });
});
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });
const host = () => ({ checkVisibility: vi.fn(() => true), parentElement: null }) as unknown as Element;
function frame() {
  const callbacks = [...frames.values()]; frames.clear();
  for (const callback of callbacks) callback(16);
}

describe("Local loader activity", () => {
  it("owns no frame while the Local window is hidden and resumes on reveal", () => {
    page.visibilityState = "hidden";
    const tick = vi.fn();
    cleanups.push(startLoaderRun({ host: host(), tick, local: true }));
    expect(frames.size).toBe(0);
    page.visibilityState = "visible"; page.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(1); frame(); expect(tick).toHaveBeenCalledOnce();
    page.visibilityState = "hidden"; page.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(0);
  });

  it("checks Local visibility on activity changes, not every animation frame", () => {
    const element = host(), tick = vi.fn();
    cleanups.push(startLoaderRun({ host: element, tick, local: true }));
    for (let index = 0; index < 60; index++) frame();
    console.info(JSON.stringify({ frames: 60, visibilityReads: vi.mocked(element.checkVisibility).mock.calls.length }));
    expect(tick).toHaveBeenCalledTimes(60);
    expect(element.checkVisibility).toHaveBeenCalledTimes(1);
    focused = false; win.dispatchEvent(new Event("blur")); expect(frames.size).toBe(0);
    focused = true; win.dispatchEvent(new Event("focus")); expect(frames.size).toBe(1);
  });

  it("removes off-screen Local hosts and releases the last shared frame", () => {
    const element = host(), tick = vi.fn();
    const stop = startLoaderRun({ host: element, tick, local: true }); cleanups.push(stop);
    intersection([{ target: element, isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(frames.size).toBe(0);
    intersection([{ target: element, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(frames.size).toBe(1);
    stop(); expect(frames.size).toBe(0);
    win.dispatchEvent(new Event("focus")); expect(frames.size).toBe(0);
  });

  it("keeps the existing cloud/default loader loop unchanged", () => {
    page.visibilityState = "hidden";
    const tick = vi.fn(), element = host();
    cleanups.push(startLoaderRun({ host: element, tick }));
    expect(frames.size).toBe(1);
    for (let index = 0; index < 60; index++) frame();
    expect(tick).toHaveBeenCalledTimes(60);
    expect(element.checkVisibility).toHaveBeenCalledTimes(60);
  });

  it("settles an active Local run when its retained owner deactivates", () => {
    const onActivity = vi.fn();
    const stop = startLoaderRun({ host: host(), tick: vi.fn(), local: true, onActivity });
    cleanups.push(stop);
    expect(onActivity).toHaveBeenLastCalledWith(true);
    stop();
    expect(onActivity).toHaveBeenLastCalledWith(false);
    expect(frames.size).toBe(0);
  });
});
