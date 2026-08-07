import { describe, expect, it, vi } from "vitest";

import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("KeyedAsyncCache", () => {
  it("evicts inactive LRU payloads when a byte-style weight budget is exceeded", async () => {
    const cache = new KeyedAsyncCache<string>({
      maxEntries: 10,
      maxWeight: 5,
      weightOf: (value) => value.length,
    });

    await cache.load("first", async () => "aaaa");
    await cache.load("second", async () => "bbbb");

    expect(cache.keys()).toEqual(["second"]);
    expect(cache.peekSnapshot("first").data).toBeUndefined();
    expect(cache.peekSnapshot("second").data).toBe("bbbb");
  });

  it("returns stable snapshots and deduplicates concurrent reads", async () => {
    const cache = new KeyedAsyncCache<string>();
    const request = deferred<string>();
    const fetcher = vi.fn(() => request.promise);

    const initial = cache.getSnapshot("repo-a");
    expect(cache.getSnapshot("repo-a")).toBe(initial);

    const first = cache.load("repo-a", fetcher);
    const second = cache.load("repo-a", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(0);

    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    request.resolve("ready");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "ready",
      "ready",
    ]);
    expect(cache.getSnapshot("repo-a").data).toBe("ready");
  });

  it("peekSnapshot reads without creating an entry or touching LRU order", () => {
    const cache = new KeyedAsyncCache<string>(2);
    // Peeking an unknown key returns the shared initial snapshot and does NOT
    // create a retained entry (so it can't evict live keys during a render).
    const cold = cache.peekSnapshot("ghost");
    expect(cold).toMatchObject({ data: undefined, loading: true });
    expect(cache.keys()).toEqual([]);

    // Fill the cache to its bound with two subscribed (retained) keys.
    cache.setData("a", "A");
    cache.subscribe("a", () => {});
    cache.setData("b", "B");
    cache.subscribe("b", () => {});
    expect(new Set(cache.keys())).toEqual(new Set(["a", "b"]));

    // Peeking many times must not create a 3rd entry nor evict "a"/"b".
    for (let i = 0; i < 10; i++) {
      cache.peekSnapshot("a");
      cache.peekSnapshot("z");
    }
    expect(new Set(cache.keys())).toEqual(new Set(["a", "b"]));
    expect(cache.peekSnapshot("a").data).toBe("A");
  });

  it("keeps cached data visible while a forced refresh is pending", async () => {
    const cache = new KeyedAsyncCache<string>();
    cache.setData("repo-a", "cached");
    const request = deferred<string>();

    const refresh = cache.load("repo-a", () => request.promise, {
      force: true,
    });
    const pending = cache.getSnapshot("repo-a");
    expect(pending).toMatchObject({
      data: "cached",
      loading: false,
      refreshing: true,
    });

    request.resolve("fresh");
    await refresh;
    expect(cache.getSnapshot("repo-a")).toMatchObject({
      data: "fresh",
      loading: false,
      refreshing: false,
    });
  });

  it("does not let an older read overwrite an optimistic write", async () => {
    const cache = new KeyedAsyncCache<string>();
    const request = deferred<string>();
    const read = cache.load("settings", () => request.promise);
    cache.setData("settings", "written");

    request.resolve("stale-read");
    await read;
    expect(cache.getSnapshot("settings").data).toBe("written");
  });

  it("notifies mounted consumers on invalidation without clearing confirmed data", () => {
    const cache = new KeyedAsyncCache<string>();
    cache.setData("settings", "confirmed");
    const before = cache.getSnapshot("settings");
    const listener = vi.fn();
    const unsubscribe = cache.subscribe("settings", listener);

    cache.invalidate("settings");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(cache.getSnapshot("settings")).not.toBe(before);
    expect(cache.getSnapshot("settings").data).toBe("confirmed");
    expect(cache.getSnapshot("settings").invalidationVersion).toBe(
      before.invalidationVersion + 1,
    );
    unsubscribe();
  });

  it("queues one authoritative refresh when invalidated during a read", async () => {
    const cache = new KeyedAsyncCache<string>();
    cache.setData("settings", "cached");
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const initialRead = cache.load("settings", fetcher, { force: true });
    await Promise.resolve();
    cache.invalidate("settings");
    const forcedA = cache.load("settings", fetcher, { force: true });
    const forcedB = cache.load("settings", fetcher, { force: true });

    first.resolve("old");
    await initialRead;
    expect(cache.getSnapshot("settings")).toMatchObject({
      data: "cached",
      refreshing: true,
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    second.resolve("new");
    await expect(Promise.all([forcedA, forcedB])).resolves.toEqual([
      "new",
      "new",
    ]);
    expect(cache.getSnapshot("settings").data).toBe("new");
  });

  it("queues another generation when invalidated during a follow-up read", async () => {
    const cache = new KeyedAsyncCache<string>();
    cache.setData("settings", "cached");
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise);

    const initial = cache.load("settings", fetcher, { force: true });
    await Promise.resolve();
    cache.invalidate("settings");
    const firstFollowUp = cache.load("settings", fetcher);
    first.resolve("first-stale");
    await initial;
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    cache.invalidate("settings");
    const finalFollowUp = cache.load("settings", fetcher);
    second.resolve("second-stale");
    await firstFollowUp;
    expect(cache.getSnapshot("settings").data).toBe("cached");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));

    third.resolve("authoritative");
    await expect(finalFollowUp).resolves.toBe("authoritative");
    expect(cache.getSnapshot("settings")).toMatchObject({
      data: "authoritative",
      refreshing: false,
    });
  });

  it("deduplicates repeated forced callers when no newer invalidation exists", async () => {
    const cache = new KeyedAsyncCache<string>();
    const request = deferred<string>();
    const fetcher = vi.fn(() => request.promise);

    const first = cache.load("settings", fetcher, { force: true });
    const second = cache.load("settings", fetcher, { force: true });
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);

    request.resolve("ready");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "ready",
      "ready",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("cancels a queued invalidation refresh after an authoritative write", async () => {
    const cache = new KeyedAsyncCache<string>();
    const request = deferred<string>();
    const fetcher = vi.fn(() => request.promise);

    const read = cache.load("settings", fetcher);
    await Promise.resolve();
    cache.invalidate("settings");
    const queued = cache.load("settings", fetcher);
    cache.setData("settings", "written");

    request.resolve("old");
    await read;
    await expect(queued).resolves.toBe("written");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.getSnapshot("settings").data).toBe("written");
  });

  it("retains a successful snapshot when background refresh fails", async () => {
    const cache = new KeyedAsyncCache<string>();
    cache.setData("settings", "saved");

    await expect(
      cache.load(
        "settings",
        async () => {
          throw new Error("offline");
        },
        { force: true },
      ),
    ).rejects.toThrow("offline");

    expect(cache.getSnapshot("settings")).toMatchObject({
      data: "saved",
      loading: false,
      refreshing: false,
      error: expect.objectContaining({ message: "offline" }),
    });
  });

  it("evicts the least-recent inactive key at its retention bound", () => {
    const cache = new KeyedAsyncCache<string>(2);
    cache.setData("old", "a");
    cache.setData("recent", "b");
    cache.setData("new", "c");

    expect(cache.keys()).toEqual(["recent", "new"]);
  });

  it("returns to its hard bound after a concurrent prefetch burst settles", async () => {
    const cache = new KeyedAsyncCache<string>(1);

    await Promise.all([
      cache.load("first", async () => "a"),
      cache.load("second", async () => "b"),
    ]);

    expect(cache.keys()).toEqual(["second"]);
  });

  it("keeps a new request attached when every older cache entry is subscribed", async () => {
    const cache = new KeyedAsyncCache<string>(1);
    const unsubscribeOld = cache.subscribe("old", () => {});
    cache.setData("old", "retained");
    const request = deferred<string>();

    const load = cache.load("new", () => request.promise);
    const listener = vi.fn();
    const unsubscribeNew = cache.subscribe("new", listener);
    expect(cache.keys()).toEqual(["old", "new"]);

    request.resolve("ready");
    await expect(load).resolves.toBe("ready");
    expect(cache.getSnapshot("new")).toMatchObject({
      data: "ready",
      loading: false,
      refreshing: false,
    });
    expect(listener).toHaveBeenCalledOnce();

    unsubscribeOld();
    expect(cache.keys()).toEqual(["new"]);
    unsubscribeNew();
  });

  it("returns to its hard bound when a retained subscriber leaves", () => {
    const cache = new KeyedAsyncCache<string>(1);
    const unsubscribeOld = cache.subscribe("old", () => {});
    cache.setData("old", "a");
    const unsubscribeNew = cache.subscribe("new", () => {});
    cache.setData("new", "b");
    expect(cache.keys()).toHaveLength(2);

    unsubscribeOld();
    expect(cache.keys()).toEqual(["new"]);
    unsubscribeNew();
  });
});
