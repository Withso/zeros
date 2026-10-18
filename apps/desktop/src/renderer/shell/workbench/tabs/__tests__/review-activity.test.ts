import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewProvider } from "../../../pr/review-provider";
import type { PR, PrChecksResult } from "../../../../platform/git";

const fixture = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  refs: [] as Array<{ current: unknown }>, cursor: 0,
}));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useRef: (initial: unknown) => fixture.refs[fixture.cursor++] ??= { current: initial },
  useEffect: (effect: () => void | (() => void)) => { fixture.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
let review: typeof import("../review-data");
let page: EventTarget & { visibilityState: string; hasFocus: () => boolean };
let focused: boolean;
let provider: ReviewProvider;
const cleanups: Array<() => void> = [];
const pending: PrChecksResult = { checks: [], deployments: [], total: 1, passed: 0, failed: 0, pending: 1 };
const settled: PrChecksResult = { ...pending, total: 0, pending: 0 };
function unmount() { for (const cleanup of cleanups.splice(0)) cleanup(); }
function Fixture(workspaceId = "personal-workspace", active = true, refreshKey = 1) {
  fixture.cursor = 0;
  const value = review.useReviewLiveData({ provider, workspaceId, prNumber: 42, active, refreshKey });
  for (const effect of fixture.effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  return value;
}
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  fixture.effects.length = 0; fixture.refs.length = 0;
  review = await import("../review-data");
  focused = true;
  page = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval }));
  provider = {
    family: "github", hostOrigin: "github.com", cacheKey: "github:activity", hostLabel: "GitHub",
    capabilities: { reviewNoun: "pull request", mergeMethods: [] },
    authStatus: vi.fn(async () => ({ authenticated: true, login: "reviewer" })),
    getPr: vi.fn(async target => ({ number: 42, state: "ready", title: target.workspaceId } as PR)),
    getChecks: vi.fn(async () => settled), getCommits: vi.fn(async () => []), getTimeline: vi.fn(async () => []),
    addComment: vi.fn(), merge: vi.fn(), markReady: vi.fn(),
  };
});
afterEach(() => { unmount(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Local Review observation activity", () => {
  it.each([
    ["personal-workspace", "hidden"], ["personal-workspace", "blurred"], ["personal-workspace", "retained"],
    ["organization-workspace", "hidden"], ["organization-workspace", "blurred"],
  ])("starts no reads or timers for %s while %s", async (id, mode) => {
    if (mode === "hidden") page.visibilityState = "hidden";
    if (mode === "blurred") focused = false;
    const watch = vi.spyOn(window, "addEventListener");
    Fixture(id, mode !== "retained"); await vi.advanceTimersByTimeAsync(60_000);
    console.info(JSON.stringify({ mode, id, reads: vi.mocked(provider.getPr).mock.calls.length, timers: vi.getTimerCount() }));
    expect(provider.authStatus).not.toHaveBeenCalled(); expect(provider.getPr).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    if (mode === "retained") expect(watch).not.toHaveBeenCalled();
  });

  it.each(["hidden", "blurred"])("disarms both full and pending-check lanes while %s and preserves the snapshot", async mode => {
    vi.mocked(provider.getChecks).mockResolvedValue(pending);
    await review.prefetchReviewLiveData(provider, "personal-workspace", 42);
    const confirmed = review.peekReviewLiveData(provider, "personal-workspace", 42);
    vi.mocked(provider.getPr).mockClear(); vi.mocked(provider.getChecks).mockClear();
    Fixture();
    if (mode === "hidden") page.visibilityState = "hidden";
    else focused = false;
    page.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider.getPr).not.toHaveBeenCalled(); expect(provider.getChecks).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(review.peekReviewLiveData(provider, "personal-workspace", 42).pr).toBe(confirmed.pr);
    page.visibilityState = "visible"; focused = true;
    window.dispatchEvent(new Event("focus")); page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.getPr).toHaveBeenCalledOnce(); expect(provider.getChecks).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(2);
  });

  it("cancels a delayed refresh on blur and preserves its invalidation until return", async () => {
    await review.prefetchReviewLiveData(provider, "personal-workspace", 42);
    Fixture(); unmount();
    vi.mocked(provider.getPr).mockClear();
    Fixture("personal-workspace", true, 2);
    expect(vi.getTimerCount()).toBeGreaterThan(1);
    focused = false; window.dispatchEvent(new Event("blur"));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider.getPr).not.toHaveBeenCalled();
    focused = true; window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.getPr).toHaveBeenCalledOnce();
  });

  it("restores only the exact owner through A to hidden B to A", async () => {
    Fixture("personal-workspace"); await vi.advanceTimersByTimeAsync(0); unmount();
    const before = review.peekReviewLiveData(provider, "personal-workspace", 42).pr;
    focused = false; fixture.refs.length = 0;
    expect(Fixture("organization-workspace").snap.pr).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider.getPr).toHaveBeenCalledOnce();
    focused = true; window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(0); unmount();
    fixture.refs.length = 0;
    expect(Fixture("personal-workspace").snap.pr).toBe(before);
    await vi.advanceTimersByTimeAsync(0);
    expect(review.peekReviewLiveData(provider, "organization-workspace", 42).pr?.title).toBe("organization-workspace");
  });

  it("defers a superseded in-flight successor while hidden and keeps the last confirmed snapshot", async () => {
    await review.prefetchReviewLiveData(provider, "personal-workspace", 42);
    const confirmed = review.peekReviewLiveData(provider, "personal-workspace", 42).pr;
    let finish!: (value: PR) => void;
    vi.mocked(provider.getPr).mockClear().mockImplementationOnce(() => new Promise(done => { finish = done; }));
    Fixture(); await vi.advanceTimersByTimeAsync(60_000);
    expect(provider.getPr).toHaveBeenCalledOnce();
    focused = false; window.dispatchEvent(new Event("blur")); unmount();
    Fixture("personal-workspace", true, 2);
    finish({ ...confirmed!, title: "superseded" }); await vi.advanceTimersByTimeAsync(0);
    expect(provider.getPr).toHaveBeenCalledOnce();
    expect(review.peekReviewLiveData(provider, "personal-workspace", 42).pr).toBe(confirmed);
    focused = true; window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(0);
    expect(provider.getPr).toHaveBeenCalledTimes(2);
    expect(review.peekReviewLiveData(provider, "personal-workspace", 42).pr?.title).toBe("personal-workspace");
  });

  it.each(["hidden", "blurred", "retained"])("preserves cloud observation while %s", async mode => {
    if (mode === "hidden") page.visibilityState = "hidden";
    if (mode === "blurred") focused = false;
    Fixture("cloud://organization/workspace", mode !== "retained");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider.getPr).toHaveBeenCalledTimes(mode === "blurred" ? 2 : 1);
    expect(vi.getTimerCount()).toBe(mode === "retained" ? 0 : 1);
  });
});
