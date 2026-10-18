import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, read: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useMemo: (compute: () => unknown) => compute(),
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, vi.fn()],
  useEffect: (effect: () => void | (() => void)) => { fixture.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../../../platform/github-review", () => ({
  getPrInlineReview: fixture.read, postPrLineComment: vi.fn(), replyPrReviewThread: vi.fn(), setPrReviewThreadResolved: vi.fn(),
}));
vi.mock("../../../platform/bridge/active-bridge", () => ({ onActiveBridgeConnected: () => () => {} }));
let useGithubReview: typeof import("../use-github-review").useGithubReview;
let page: EventTarget & { visibilityState: string; hasFocus: () => boolean };
let focused: boolean;
const cleanups: Array<() => void> = [];
function unmount() { for (const cleanup of cleanups.splice(0)) cleanup(); }
function Fixture(cwd = "/personal/project", workspaceId = "personal-workspace", active = true) {
  const value = useGithubReview({ cwd, workspaceId, prNumber: 42, active });
  for (const effect of fixture.effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  return value;
}
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  fixture.effects.length = 0; fixture.read.mockReset().mockResolvedValue({ headSha: "a", baseSha: "b", threads: [], annotations: [] });
  ({ useGithubReview } = await import("../use-github-review"));
  focused = true;
  page = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  vi.stubGlobal("document", page); vi.stubGlobal("window", new EventTarget());
});
afterEach(() => { unmount(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Local inline review activity", () => {
  it.each([
    ["/personal/project", "hidden"], ["/personal/project", "blurred"],
    ["/organization/project", "hidden"], ["/organization/project", "blurred"],
  ])("keeps %s inert while %s", async (cwd, mode) => {
    if (mode === "hidden") page.visibilityState = "hidden";
    else focused = false;
    Fixture(cwd); await vi.advanceTimersByTimeAsync(60_000);
    console.info(JSON.stringify({ mode, cwd, reads: fixture.read.mock.calls.length, timers: vi.getTimerCount() }));
    expect(fixture.read).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("retains confirmed data through blur and reads once on return", async () => {
    Fixture(); await vi.advanceTimersByTimeAsync(0); unmount();
    focused = false;
    const retained = Fixture().snapshot;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.read).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    unmount(); focused = true;
    expect(Fixture().snapshot).toBe(retained);
    await vi.advanceTimersByTimeAsync(0); expect(fixture.read).toHaveBeenCalledTimes(2);
  });
  it.each(["hidden", "blurred"])("preserves cloud behavior while %s", async mode => {
    if (mode === "hidden") page.visibilityState = "hidden";
    else focused = false;
    Fixture("cloud://organization/workspace", "cloud://organization/workspace");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.read).toHaveBeenCalledTimes(mode === "hidden" ? 0 : 2);
    expect(vi.getTimerCount()).toBe(1);
  });
});
