import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({
    version: 1,
    available: true,
    accessibility: true,
    screenRecording: false,
  })),
}));
vi.mock("../../../platform/runtime", () => ({ nativeInvoke: runtime.invoke }));

import { watchComputerUseStatus } from "../computer-use-status";

let page: EventTarget & { visibilityState: string; hasFocus: () => boolean };
let focused: boolean;
const stops: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  focused = true;
  page = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    hasFocus: () => focused,
  });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", new EventTarget());
  runtime.invoke.mockClear();
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function watch(): () => void {
  const stop = watchComputerUseStatus();
  stops.push(stop);
  return stop;
}

const reads = () => runtime.invoke.mock.calls.length;

describe("Computer use grants observation", () => {
  it.each(["hidden", "blurred"])("owns no native reads or timers while %s", (mode) => {
    if (mode === "hidden") page.visibilityState = "hidden";
    if (mode === "blurred") focused = false;
    watch();
    vi.advanceTimersByTime(60_000);
    expect(reads()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads at once on reveal and owns only one visible interval", () => {
    const stop = watch();
    expect(reads()).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(reads()).toBe(3);
    focused = false;
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(60_000);
    expect(reads()).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
    focused = true;
    window.dispatchEvent(new Event("focus"));
    expect(reads()).toBe(4);
    expect(vi.getTimerCount()).toBe(1);
    stop();
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(60_000);
    expect(reads()).toBe(4);
  });

  it("shares one poll between the General rows that watch", () => {
    const computerUse = watch();
    const privacy = watch();
    expect(reads()).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(reads()).toBe(3);
    expect(vi.getTimerCount()).toBe(1);
    computerUse();
    computerUse();
    vi.advanceTimersByTime(5_000);
    expect(reads()).toBe(4);
    privacy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
