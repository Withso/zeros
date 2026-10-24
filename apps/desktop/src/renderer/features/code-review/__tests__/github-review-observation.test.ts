import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PrInlineReview } from "@zeros/protocol/github-review";

const f = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, read: vi.fn(), callbacks: 0,
  connected: new Set<(client: never, info: { initial: boolean }) => void>() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useMemo: (compute: () => unknown) => compute(),
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [typeof value === "function" ? value() : value, vi.fn()],
  useEffect: (effect: () => void | (() => void)) => { f.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../../../platform/github-review", () => ({ getPrInlineReview: f.read, postPrLineComment: vi.fn(), replyPrReviewThread: vi.fn(), setPrReviewThreadResolved: vi.fn() }));
vi.mock("../../../platform/bridge/active-bridge", () => ({ onActiveBridgeConnected: (callback: (client: never, info: { initial: boolean }) => void) => {
  f.connected.add(callback); return () => f.connected.delete(callback);
} }));

let useGithubReview: typeof import("../use-github-review").useGithubReview;
let page: EventTarget & { visibilityState: string; hasFocus: () => boolean };
let focused = true;
const stops = new Set<() => void>();
const snapshot = (headSha = "head"): PrInlineReview => ({ headSha, baseSha: "base", threads: [], annotations: [],
  threadsTruncated: false, annotationsTruncated: false, annotationError: null });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
function Fixture(workspaceId = "A", extra: Partial<Parameters<typeof useGithubReview>[0]> = {}) {
  const value = useGithubReview({ cwd: `/workspace/${workspaceId}`, workspaceId, prNumber: 7, active: true, ...extra });
  const cleanups = f.effects.splice(0).map(effect => effect());
  const stop = () => { cleanups.splice(0).forEach(cleanup => cleanup?.()); stops.delete(stop); };
  stops.add(stop);
  return { ...value, stop };
}
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  f.effects.length = 0; f.read.mockReset().mockImplementation(async () => snapshot()); f.connected.clear(); f.callbacks = 0;
  focused = true; page = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  const timeout = setTimeout, interval = setInterval;
  vi.stubGlobal("setTimeout", ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    timeout(() => { f.callbacks++; handler(...args); }, delay)) as typeof setTimeout);
  vi.stubGlobal("setInterval", ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    interval(() => { f.callbacks++; handler(...args); }, delay)) as typeof setInterval);
  vi.stubGlobal("document", page); vi.stubGlobal("window", new EventTarget());
  ({ useGithubReview } = await import("../use-github-review"));
});
afterEach(() => {
  for (const stop of [...stops]) stop();
  expect(vi.getTimerCount()).toBe(0);
  vi.unstubAllGlobals(); vi.useRealTimers();
});

it("shares one Local read and one next-due timer across two consumers, with no timer during the read", async () => {
  const held = deferred<PrInlineReview>(); f.read.mockReturnValue(held.promise);
  const one = Fixture(), two = Fixture(); await vi.advanceTimersByTimeAsync(0);
  expect(f.read).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  held.resolve(snapshot()); await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1); expect(f.connected.size).toBe(1);
  one.stop(); expect(vi.getTimerCount()).toBe(1);
  two.stop(); expect(vi.getTimerCount()).toBe(0);
});

it.each(["unchanged", "error"])("backs off %s reads through 30s, 60s and 120s, then resets on explicit refresh", async mode => {
  const view = Fixture(); await vi.advanceTimersByTimeAsync(0);
  const { githubReviewCache, githubReviewKey } = await import("../github-review-cache");
  const confirmed = githubReviewCache.getSnapshot(githubReviewKey("A", 7)).data;
  if (mode === "error") f.read.mockRejectedValue(new Error("GitHub unavailable"));
  await vi.advanceTimersByTimeAsync(30_000); expect(f.read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(59_999); expect(f.read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); expect(f.read).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(119_999); expect(f.read).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1); expect(f.read).toHaveBeenCalledTimes(4);
  expect(githubReviewCache.getSnapshot(githubReviewKey("A", 7)).data).toBe(confirmed);
  await vi.advanceTimersByTimeAsync(120_000); expect(f.read).toHaveBeenCalledTimes(5);
  f.read.mockImplementation(async () => snapshot()); await view.refresh();
  expect(f.read).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(30_000); expect(f.read).toHaveBeenCalledTimes(7);
});

it.each(["hidden", "blurred"])("cancels every scheduled callback while %s and refreshes once on return", async mode => {
  Fixture(); Fixture(); await vi.advanceTimersByTimeAsync(0);
  if (mode === "hidden") { page.visibilityState = "hidden"; page.dispatchEvent(new Event("visibilitychange")); }
  else { focused = false; window.dispatchEvent(new Event("blur")); }
  f.callbacks = 0;
  await vi.advanceTimersByTimeAsync(240_000);
  expect(f.callbacks).toBe(0); expect(vi.getTimerCount()).toBe(0); expect(f.read).toHaveBeenCalledOnce();
  page.visibilityState = "visible"; focused = true;
  page.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(1);
});

it("refreshes immediately on reconnect and on a confirmed revision change, then returns to 30s", async () => {
  Fixture(); await vi.advanceTimersByTimeAsync(90_000);
  expect(f.read).toHaveBeenCalledTimes(3);
  for (const callback of f.connected) callback(null as never, { initial: false });
  await vi.advanceTimersByTimeAsync(0); expect(f.read).toHaveBeenCalledTimes(4);
  f.read.mockResolvedValue(snapshot("new-head"));
  Fixture("A", { confirmedHeadSha: "new-head", confirmedBaseSha: "base" });
  await vi.advanceTimersByTimeAsync(0); expect(f.read).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(30_000); expect(f.read).toHaveBeenCalledTimes(6);
});

it("fences the old A result across A → B → A and retains only the new observation", async () => {
  const old = deferred<PrInlineReview>(), next = deferred<PrInlineReview>();
  f.read.mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot("B")).mockReturnValueOnce(next.promise);
  const a = Fixture(); await vi.advanceTimersByTimeAsync(0); a.stop();
  const b = Fixture("B"); await vi.advanceTimersByTimeAsync(0); b.stop();
  Fixture(); await vi.advanceTimersByTimeAsync(0);
  const { githubReviewCache, githubReviewKey } = await import("../github-review-cache");
  old.resolve(snapshot("old-A")); await vi.advanceTimersByTimeAsync(0);
  expect(githubReviewCache.getSnapshot(githubReviewKey("A", 7)).data).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  next.resolve(snapshot("new-A")); await vi.advanceTimersByTimeAsync(0);
  expect(githubReviewCache.getSnapshot(githubReviewKey("A", 7)).data?.headSha).toBe("new-A");
  expect(githubReviewCache.getSnapshot(githubReviewKey("B", 7)).data?.headSha).toBe("B");
  expect(vi.getTimerCount()).toBe(1);
});

it("coalesces explicit refreshes during a read and starts no queued work while hidden", async () => {
  const view = Fixture(); await vi.advanceTimersByTimeAsync(0);
  const held = deferred<PrInlineReview>(); f.read.mockReturnValueOnce(held.promise);
  const first = view.refresh(); await vi.advanceTimersByTimeAsync(0);
  const second = view.refresh(), third = view.refresh();
  expect(vi.getTimerCount()).toBe(0);
  page.visibilityState = "hidden"; page.dispatchEvent(new Event("visibilitychange"));
  held.resolve(snapshot("superseded")); await Promise.all([first, second, third]);
  f.callbacks = 0; await vi.advanceTimersByTimeAsync(240_000);
  expect(f.read).toHaveBeenCalledTimes(2); expect(f.callbacks).toBe(0);
  page.visibilityState = "visible"; page.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0); expect(f.read).toHaveBeenCalledTimes(3);
  view.stop(); await view.refresh(); await vi.advanceTimersByTimeAsync(120_000);
  expect(f.read).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
});

it("performs one replacement read for many explicit refreshes while a read is held", async () => {
  const view = Fixture(); await vi.advanceTimersByTimeAsync(0);
  const held = deferred<PrInlineReview>(); f.read.mockReturnValueOnce(held.promise);
  const first = view.refresh(); await vi.advanceTimersByTimeAsync(0);
  const second = view.refresh(), third = view.refresh();
  held.resolve(snapshot("superseded")); await Promise.all([first, second, third]);
  expect(f.read).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(1);
});

it("retires deleted workspace observers and rejects their held replies after reopening", async () => {
  const old = deferred<PrInlineReview>(); f.read.mockReturnValueOnce(old.promise);
  Fixture(); await vi.advanceTimersByTimeAsync(0);
  const { forgetPrCachesForWorkspace } = await import("../../../shell/pr/pr-cache-forget");
  const { forgetReviewCachesForFolders } = await import("../review-cache-forget");
  forgetPrCachesForWorkspace("A"); forgetReviewCachesForFolders(folder => folder === "/workspace/A");
  expect(vi.getTimerCount()).toBe(0); expect(f.connected.size).toBe(0);
  Fixture(); await vi.advanceTimersByTimeAsync(0);
  const { githubReviewCache, githubReviewKey } = await import("../github-review-cache");
  const confirmed = githubReviewCache.getSnapshot(githubReviewKey("A", 7)).data;
  old.resolve(snapshot("deleted")); await vi.advanceTimersByTimeAsync(0);
  expect(githubReviewCache.getSnapshot(githubReviewKey("A", 7)).data).toBe(confirmed);
  expect(f.read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(1);
});

it("resets backoff when a periodic read confirms changed content", async () => {
  Fixture(); await vi.advanceTimersByTimeAsync(90_000); expect(f.read).toHaveBeenCalledTimes(3);
  f.read.mockResolvedValue(snapshot("changed"));
  await vi.advanceTimersByTimeAsync(120_000); expect(f.read).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(30_000); expect(f.read).toHaveBeenCalledTimes(5);
});
