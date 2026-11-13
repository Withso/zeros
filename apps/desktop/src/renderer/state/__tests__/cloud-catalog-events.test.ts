import { expect, it, vi } from "vitest";
import { catalogRefreshDelayMs, watchCloudCatalogEvents } from "../cloud-catalog-events";

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
  const f = fakeListen(), onRefresh = vi.fn(), onModeChange = vi.fn();
  const watch = watchCloudCatalogEvents(f.listen, { refresh: onRefresh, modeChanged: onModeChange });
  await Promise.resolve(); await Promise.resolve();
  f.emit("cloud-catalog-changed", { organizationId: "org", workspaceId: "ws", change: "document" });
  expect(onRefresh).not.toHaveBeenCalled();
  f.emit("cloud-catalog-stream", { catalogEvents: true });
  expect(watch.active()).toBe(true); expect(onModeChange).toHaveBeenCalledTimes(1); expect(onRefresh).toHaveBeenCalledTimes(1);
  f.emit("cloud-catalog-changed", { organizationId: "org", workspaceId: "ws", change: "lifecycle" });
  expect(onRefresh).toHaveBeenCalledTimes(2);
  f.emit("cloud-catalog-changed", { organizationId: 7 });
  expect(onRefresh).toHaveBeenCalledTimes(2);
  f.emit("cloud-catalog-stream", { catalogEvents: false });
  expect(watch.active()).toBe(false); expect(onModeChange).toHaveBeenCalledTimes(2);
  watch.stop(); expect(f.handlers.size).toBe(0);
});
