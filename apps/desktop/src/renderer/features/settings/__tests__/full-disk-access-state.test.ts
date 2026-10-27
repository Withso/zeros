import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FullDiskAccessSnapshot } from "../../../../../shared/full-disk-access";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/runtime", () => ({ nativeInvoke: invoke }));
import {
  FULL_DISK_ACCESS_KEY as key,
  fullDiskAccessCache as cache,
  observeFullDiskAccess,
  parseFullDiskAccessSnapshot,
  readFullDiskAccess,
} from "../full-disk-access-state";

const available: FullDiskAccessSnapshot = {
  status: "available",
};
const denied: FullDiskAccessSnapshot = { ...available, status: "denied" };
let page: EventTarget & { visibilityState: string };
let windowEvents: EventTarget;
let stops: (() => void)[] = [];
function observe() {
  const stop = observeFullDiskAccess();
  stops.push(stop);
  return stop;
}
const load = () => cache.load(key, readFullDiskAccess, { force: true });

beforeEach(() => {
  cache.clear();
  invoke.mockReset().mockResolvedValue(denied);
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  windowEvents = new EventTarget();
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", windowEvents);
});
afterEach(() => {
  stops.forEach((stop) => stop());
  stops = [];
  cache.clear();
  vi.unstubAllGlobals();
});

describe("device Full Disk Access observation", () => {
  it("uses only the fixed native device command, independent of workspace/owner selection", async () => {
    observe();
    expect(await load()).toEqual(denied);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("full_disk_access_status");
    expect(cache.keys()).toEqual(["this-mac"]);
  });

  it("shares requests and retains the confirmed status while checking again", async () => {
    observe();
    observe();
    cache.setData(key, denied);
    let resolve!: (value: FullDiskAccessSnapshot) => void;
    invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const a = load(),
      b = load();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(cache.getSnapshot(key).data).toBe(denied);
    resolve(available);
    await Promise.all([a, b]);
    expect(cache.getSnapshot(key).data).toEqual(available);
  });

  it("invalidates on return from System Settings and observes revocation", async () => {
    observe();
    cache.setData(key, available);
    const before = cache.getSnapshot(key).invalidationVersion;
    windowEvents.dispatchEvent(new Event("focus"));
    expect(cache.getSnapshot(key).invalidationVersion).toBe(before + 1);
    expect(cache.getSnapshot(key).data).toBe(available);
    await load();
    expect(cache.getSnapshot(key).data).toEqual(denied);
  });

  it("starts no native reads while hidden or after the last observer leaves", async () => {
    const stop = observe();
    page.visibilityState = "hidden";
    await expect(load()).rejects.toThrow("inactive");
    page.visibilityState = "visible";
    stop();
    await expect(load()).rejects.toThrow("inactive");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("fences a held reply across hide and reveal while keeping the last confirmed status", async () => {
    let stop = observe();
    cache.setData(key, denied);
    let resolve!: (value: FullDiskAccessSnapshot) => void;
    invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const stale = load();
    await Promise.resolve();
    stop();
    stop = observe();
    const fresh = load();
    resolve(available);
    await stale;
    await fresh;
    expect(cache.getSnapshot(key).data).toEqual(denied);
    expect(invoke).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does not run a queued refresh after Settings becomes hidden", async () => {
    const stop = observe();
    cache.setData(key, denied);
    let resolve!: (value: FullDiskAccessSnapshot) => void;
    invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const stale = load().catch(() => {});
    await Promise.resolve();
    windowEvents.dispatchEvent(new Event("focus"));
    const queued = load().catch(() => {});
    stop();
    resolve(available);
    await Promise.all([stale, queued]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(cache.getSnapshot(key).data).toBe(denied);
  });

  it("retires reads even when visibility changes before the visibility event", async () => {
    observe();
    cache.setData(key, denied);
    let resolve!: (value: FullDiskAccessSnapshot) => void;
    invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = load();
    await Promise.resolve();
    page.visibilityState = "hidden";
    resolve(available);
    await expect(pending).rejects.toThrow("inactive");
    expect(cache.getSnapshot(key).data).toBe(denied);
  });

  it("removes listeners only when the last retained surface stops observing", () => {
    cache.setData(key, available);
    const first = observe(),
      second = observe();
    first();
    let before = cache.getSnapshot(key).invalidationVersion;
    windowEvents.dispatchEvent(new Event("focus"));
    expect(cache.getSnapshot(key).invalidationVersion).toBe(before + 1);
    second();
    before = cache.getSnapshot(key).invalidationVersion;
    windowEvents.dispatchEvent(new Event("focus"));
    page.dispatchEvent(new Event("visibilitychange"));
    expect(cache.getSnapshot(key).invalidationVersion).toBe(before);
  });

  it("retires failed reads when the window hides before its visibility event", async () => {
    observe();
    cache.setData(key, denied);
    let reject!: (reason: Error) => void;
    invoke.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const pending = load();
    await Promise.resolve();
    page.visibilityState = "hidden";
    reject(new Error("Native transport closed"));
    await expect(pending).rejects.toThrow();
    expect(cache.getSnapshot(key).data).toBe(denied);
    expect(cache.getSnapshot(key).error).toBeNull();
  });

  it.each([
    null,
    {},
    { ...available, status: "granted" },
    { status: null },
    { status: true },
    ["available"],
  ])("rejects malformed native answers", (value) => {
    expect(() => parseFullDiskAccessSnapshot(value)).toThrow(
      "Could not verify",
    );
  });
});
