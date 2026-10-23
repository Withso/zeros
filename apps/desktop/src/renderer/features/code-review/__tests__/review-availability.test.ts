import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, list: vi.fn(), connected: vi.fn(), on: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useMemo: (compute: () => unknown) => compute(),
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [typeof value === "function" ? value() : value, vi.fn()],
  useEffect: (effect: () => void | (() => void)) => { f.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../../../platform/bridge/code-review-bridge", () => ({ listCodeReviewThreads: f.list, createCodeReviewThread: vi.fn(), replyCodeReviewThread: vi.fn(), setCodeReviewThreadResolved: vi.fn() }));
vi.mock("../../../platform/bridge/active-bridge", () => ({ getActiveBridge: () => ({ on: f.on }), onActiveBridgeChange: () => () => {}, onActiveBridgeConnected: f.connected }));
vi.mock("../review-external-context", () => ({ useCodeReviewExternal: () => undefined }));
vi.mock("../review-annotation-view", () => ({ ReviewAnnotationView: () => null }));
const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const scoped = "cloud:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:workspace";
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); f.effects.length = 0;
  f.list.mockReset().mockResolvedValue({ workspaceId: "fixture", threads: [] });
  f.connected.mockReset().mockReturnValue(() => {}); f.on.mockReset().mockReturnValue(() => {});
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
it.each([[folder, "fixture"], ["/checkout", folder], ["/checkout", scoped]])("keeps cloud comments unavailable for cwd=%s workspaceId=%s", async (cwd, workspaceId) => {
  const { useCodeReview } = await import("../use-code-review");
  const { useInlineReview } = await import("../use-inline-review");
  const review = useCodeReview({ cwd, workspaceId, active: true, external: { threads: [], loading: true, error: "Old unsupported error" } });
  const inline = useInlineReview(review, true, "file.ts");
  const cleanups = f.effects.splice(0).map(effect => effect());
  await review.refresh(); await review.loadMore?.(); await vi.advanceTimersByTimeAsync(120_000);
  expect(f.list).not.toHaveBeenCalled(); expect(f.connected).not.toHaveBeenCalled(); expect(f.on).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0); expect(review.loading).toBe(false); expect(review.external).toBeUndefined();
  expect(inline.options.enableGutterUtility).toBe(false); expect(inline.options.enableLineSelection).toBe(false);
  cleanups.forEach(cleanup => cleanup?.());
});

it.each(["/personal", "/organization-local"])("keeps %s review shared and event-driven without a poll", async cwd => {
  const { useCodeReview } = await import("../use-code-review");
  const { useInlineReview } = await import("../use-inline-review");
  const reviews = [useCodeReview({ cwd, workspaceId: "fixture", active: true }), useCodeReview({ cwd, workspaceId: "fixture", active: true })];
  const cleanups = f.effects.splice(0).map(effect => effect());
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.list).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  expect(useInlineReview(reviews[0], true, "file.ts").options.enableGutterUtility).toBe(true);
  cleanups.forEach(cleanup => cleanup?.());
});
