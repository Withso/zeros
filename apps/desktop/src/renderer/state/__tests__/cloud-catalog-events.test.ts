import { afterEach, expect, it, vi } from "vitest";
import { CATALOG_HINT_COALESCE_MS, catalogRefreshDelayMs, watchCloudCatalogEvents } from "../cloud-catalog-events";

afterEach(() => { vi.useRealTimers(); });

function fakeListen() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const listen = vi.fn(async (name: string, handler: (payload: unknown) => void) => { handlers.set(name, handler); return () => handlers.delete(name); });
  return { listen, emit: (name: string, payload: unknown) => handlers.get(name)?.(payload), handlers };
}

it("R1 catalog-events-v1: 60 s fallback only while the stream announces it; today's 30 s / 2 s otherwise", () => {
  expect(catalogRefreshDelayMs(true, false)).toBe(60_000);
  expect(catalogRefreshDelayMs(true, true)).toBe(60_000);
  expect(catalogRefreshDelayMs(false, false)).toBe(30_000);
  expect(catalogRefreshDelayMs(false, true)).toBe(2_000);
});

it("R1 catalog-events-v1: a catalog change refreshes only while the stream is active; ready refreshes once; loss restores timers", async () => {
  vi.useFakeTimers();
  const f = fakeListen(), onRefresh = vi.fn(async () => {}), onModeChange = vi.fn();
  const watch = watchCloudCatalogEvents(f.listen, { refresh: onRefresh, modeChanged: onModeChange });
  await Promise.resolve(); await Promise.resolve();
  f.emit("cloud-catalog-changed", { organizationId: "org", workspaceId: "ws", change: "document" });
  expect(onRefresh).not.toHaveBeenCalled();
  f.emit("cloud-catalog-stream", { catalogEvents: true });
  expect(watch.active()).toBe(true); expect(onModeChange).toHaveBeenCalledTimes(1); expect(onRefresh).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(0);
  f.emit("cloud-catalog-changed", { organizationId: "org", workspaceId: "ws", change: "lifecycle" });
  await vi.advanceTimersByTimeAsync(CATALOG_HINT_COALESCE_MS);
  expect(onRefresh).toHaveBeenCalledTimes(2);
  f.emit("cloud-catalog-changed", { organizationId: 7 });
  expect(onRefresh).toHaveBeenCalledTimes(2);
  f.emit("cloud-catalog-stream", { catalogEvents: false });
  expect(watch.active()).toBe(false); expect(onModeChange).toHaveBeenCalledTimes(2);
  watch.stop(); expect(f.handlers.size).toBe(0);
});

const changed = (f: ReturnType<typeof fakeListen>) => f.emit("cloud-catalog-changed", { organizationId: "org", workspaceId: "ws", change: "document" });
async function active(refresh: () => Promise<void>) {
  vi.useFakeTimers();
  const f = fakeListen();
  const watch = watchCloudCatalogEvents(f.listen, { refresh, modeChanged: () => {} });
  await vi.advanceTimersByTimeAsync(0);
  f.emit("cloud-catalog-stream", { catalogEvents: true });
  await vi.advanceTimersByTimeAsync(0);
  return { f, watch };
}

it("R1 catalog-events-v1: a burst of hints is one refresh after a short delay, however many arrive", async () => {
  const refresh = vi.fn(async () => {});
  const { f } = await active(refresh);
  refresh.mockClear();
  for (let i = 0; i < 40; i++) { changed(f); await vi.advanceTimersByTimeAsync(10); }
  await vi.advanceTimersByTimeAsync(CATALOG_HINT_COALESCE_MS);
  expect(refresh).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10 * CATALOG_HINT_COALESCE_MS);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("R1 catalog-events-v1: hints during a held read give one trailing refresh, a short delay after it ends", async () => {
  let release!: () => void;
  const refresh = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const { f } = await active(refresh);
  expect(refresh).toHaveBeenCalledTimes(1);            // the ready refresh, still held
  for (let i = 0; i < 25; i++) changed(f);
  await vi.advanceTimersByTimeAsync(5 * CATALOG_HINT_COALESCE_MS);
  expect(refresh).toHaveBeenCalledTimes(1);             // single in flight
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(1);             // not immediately
  await vi.advanceTimersByTimeAsync(CATALOG_HINT_COALESCE_MS);
  expect(refresh).toHaveBeenCalledTimes(2);
  release(); await vi.advanceTimersByTimeAsync(10 * CATALOG_HINT_COALESCE_MS);
  expect(refresh).toHaveBeenCalledTimes(2);
});

it("R1 catalog-events-v1: stop (owner switch or teardown) cancels a pending trailing refresh, even one queued behind a held read", async () => {
  let release!: () => void;
  const refresh = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const { f, watch } = await active(refresh);
  changed(f);
  watch.stop();
  release(); await vi.advanceTimersByTimeAsync(10 * CATALOG_HINT_COALESCE_MS);
  expect(refresh).toHaveBeenCalledTimes(1);
  // A new owner's watcher starts clean and its stream ready refreshes once.
  const next = await active(vi.fn(async () => {}));
  changed(next.f); changed(next.f);
  await vi.advanceTimersByTimeAsync(CATALOG_HINT_COALESCE_MS);
  expect(f.handlers.size).toBe(0);
});

it("R1 catalog-events-v1: a renderer that subscribes after main announced the stream asks for the current state (no 30 s fallback)", async () => {
  vi.useFakeTimers();
  const f = fakeListen(), refresh = vi.fn(async () => {}), modeChanged = vi.fn();
  let answer!: (value: { catalogEvents: boolean }) => void;
  const query = vi.fn(() => new Promise<{ catalogEvents: boolean }>(resolve => { answer = resolve; }));
  const watch = watchCloudCatalogEvents(f.listen, { refresh, modeChanged }, query);
  await vi.advanceTimersByTimeAsync(0);
  expect(query).toHaveBeenCalledOnce();
  answer({ catalogEvents: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(watch.active()).toBe(true); expect(modeChanged).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1);
  expect(catalogRefreshDelayMs(watch.active(), false)).toBe(60_000);
  watch.stop();
  // An event that arrives before the answer wins; a failed query changes nothing.
  const g = fakeListen();
  let late!: (value: { catalogEvents: boolean }) => void;
  const second = watchCloudCatalogEvents(g.listen, { refresh: vi.fn(async () => {}), modeChanged: () => {} }, () => new Promise(resolve => { late = resolve; }));
  await vi.advanceTimersByTimeAsync(0);
  g.emit("cloud-catalog-stream", { catalogEvents: true });
  g.emit("cloud-catalog-stream", { catalogEvents: false });
  late({ catalogEvents: true }); await vi.advanceTimersByTimeAsync(0);
  expect(second.active()).toBe(false);
  const third = watchCloudCatalogEvents(fakeListen().listen, { refresh: vi.fn(async () => {}), modeChanged: () => {} }, () => Promise.reject(new Error("no native")));
  await vi.advanceTimersByTimeAsync(0);
  expect(third.active()).toBe(false);
  second.stop(); third.stop();
});
