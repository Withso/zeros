import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CodeReviewThread } from "@zeros/protocol/code-review";
const f = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  subscriptions: [] as Array<(listener: () => void) => () => void>,
  list: vi.fn(), available: false, handlers: new Map<string, Set<() => void>>(),
}));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useCallback: (callback: unknown) => callback, useMemo: (compute: () => unknown) => compute(),
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => void | (() => void)) => { f.effects.push(effect); },
  useSyncExternalStore: (subscribe: (listener: () => void) => () => void, snapshot: () => unknown) => { f.subscriptions.push(subscribe); return snapshot(); },
}));
vi.mock("../../../platform/bridge/code-review-bridge", () => ({ listCodeReviewThreads: f.list, createCodeReviewThread: vi.fn(), replyCodeReviewThread: vi.fn(), setCodeReviewThreadResolved: vi.fn() }));
vi.mock("../review-external-context", () => ({ useCodeReviewExternal: () => undefined }));
const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const thread: CodeReviewThread = { id: "thread", workspaceId: folder, anchor: { path: "example.ts", side: "new", startLine: 1, endLine: 1, revision: "original" },
  comments: [{ id: "comment", author: { id: "human:fixture", name: "Reviewer", kind: "human" }, body: "Retain this comment", createdAt: 1 }], resolved: false, version: 1, createdAt: 1, updatedAt: 1 };
const cleanups: Array<() => void> = [];
function on(event: string, listener: () => void) {
  const listeners = f.handlers.get(event) ?? new Set(); listeners.add(listener); f.handlers.set(event, listeners);
  return () => { listeners.delete(listener); };
}
const emit = (event: string) => { for (const listener of f.handlers.get(event) ?? []) listener(); };
const effects = () => { for (const effect of f.effects.splice(0)) { const stop = effect(); if (stop) cleanups.push(stop); } };
beforeEach(async () => {
  vi.resetModules(); f.effects.length = 0; f.subscriptions.length = 0; f.handlers.clear(); f.available = false;
  f.list.mockReset().mockResolvedValue({ workspaceId: folder, threads: [thread], partial: false });
  const { setActiveBridge } = await import("../../../platform/bridge/active-bridge");
  setActiveBridge({ on, onStatusChange: (listener: () => void) => on("status", listener), status: "disconnected", supportsEngineCapability: () => f.available } as never);
});
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

it("reacts to capability changes without waking, retains the same owner's snapshot, and disables writes while stopped", async () => {
  const { useCodeReview } = await import("../use-code-review");
  const input = { cwd: folder, workspaceId: folder, active: true };
  const unavailable = useCodeReview(input), changed = vi.fn();
  for (const subscribe of f.subscriptions.splice(0)) cleanups.push(subscribe(changed));
  effects(); await unavailable.refresh();
  expect(f.list).not.toHaveBeenCalled();
  expect(unavailable.error).toBeNull();
  expect(unavailable.notice).toMatch(/Open.*workspace/);
  f.available = true; emit("ENGINE_READY"); expect(changed).toHaveBeenCalled();
  useCodeReview(input); effects(); await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(useCodeReview(input).threads).toHaveLength(1));
  const connected = useCodeReview(input);
  f.available = false; emit("status");
  const stopped = useCodeReview(input);
  expect(stopped.ownerKey).toBe(connected.ownerKey);
  expect(stopped.threads[0].comments).toEqual(thread.comments);
  expect(stopped.threads[0]).toMatchObject({ canReply: false, canResolve: false });
  expect(stopped.workspaceCommentsAvailable).toBe(false); expect(stopped.error).toBeNull();
  expect(stopped.notice).toMatch(/Open.*workspace/);
  await stopped.refresh(); await stopped.loadMore?.();
  expect(f.list).toHaveBeenCalledOnce();
});

it("retires cached comments and a pending read when the account/owner scope changes", async () => {
  f.available = true;
  const { codeReviewCache, codeReviewCacheKey } = await import("../review-cache");
  const { invalidateCloudGithubPrScope } = await import("../../../platform/cloud-github-pr-scope");
  const { loadCodeReview, useCodeReview } = await import("../use-code-review");
  const key = codeReviewCacheKey(folder, folder);
  codeReviewCache.setData(key, { workspaceId: folder, threads: [thread], partial: false });
  let resolve!: (value: unknown) => void;
  f.list.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const pending = loadCodeReview(key, true); const settled = pending.catch(error => error);
  await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
  invalidateCloudGithubPrScope();
  expect(codeReviewCacheKey(folder, folder)).not.toBe(key);
  expect(useCodeReview({ cwd: folder, workspaceId: folder, active: true }).threads).toEqual([]);
  resolve({ workspaceId: folder, threads: [thread] });
  expect(await settled).toBeInstanceOf(Error);
});

it("keeps hidden cloud review surfaces inert", async () => {
  f.available = true;
  const { useCodeReview } = await import("../use-code-review");
  const review = useCodeReview({ cwd: folder, workspaceId: folder, active: false });
  for (const subscribe of f.subscriptions.splice(0)) cleanups.push(subscribe(() => {}));
  effects(); await review.refresh(); await review.loadMore?.();
  expect(f.list).not.toHaveBeenCalled();
  expect([...f.handlers.values()].reduce((n, handlers) => n + handlers.size, 0)).toBe(0);
});
