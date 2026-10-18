import { afterEach, describe, expect, it, vi } from "vitest";

import { DesignBackgroundWorkQueue } from "../state/design-background-work";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("design background work lifecycle", () => {
  it.each([false, true])(
    "preserves legacy running exports when the next request's latest flag is %s",
    async (latest) => {
      vi.useFakeTimers();
      const queue = new DesignBackgroundWorkQueue(4, 0);
      const held = deferred<string>();
      const exported = queue.schedule("frame", () => held.promise);
      await vi.advanceTimersByTimeAsync(0);
      const newer = queue.schedule("frame", async () => "new", { latest });
      held.resolve("export");
      await vi.runAllTimersAsync();
      expect(await exported).toBe("export");
      expect(await newer).toBe("new");
      queue.reset();
    },
  );

  it("does not retire opted-in work on behalf of an unrelated legacy caller", async () => {
    vi.useFakeTimers();
    const queue = new DesignBackgroundWorkQueue(4, 0);
    const held = deferred<string>();
    const old = queue.schedule("frame", () => held.promise, { latest: true });
    await vi.advanceTimersByTimeAsync(0);
    const newer = queue.schedule("frame", async () => "legacy");
    held.resolve("background");
    await vi.runAllTimersAsync();
    expect(await old).toBe("background");
    expect(await newer).toBe("legacy");
    queue.reset();
  });

  it("discards a running result when a newer request owns its family", async () => {
    vi.useFakeTimers();
    const queue = new DesignBackgroundWorkQueue(4, 0);
    const held = deferred<string>();
    const old = queue.schedule("local/frame/preview", () => held.promise, {
      latest: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    const newest = queue.schedule("local/frame/preview", async () => "new", {
      latest: true,
    });
    held.resolve("obsolete");
    await vi.runAllTimersAsync();
    expect(await old).toBeNull();
    expect(await newest).toBe("new");
    queue.reset();
  });

  it("keeps the producer slot occupied across retirement until work settles", async () => {
    vi.useFakeTimers();
    const queue = new DesignBackgroundWorkQueue(4, 0);
    const held = deferred<string>();
    let active = 0;
    let maximum = 0;
    const old = queue.schedule("local/old", async () => {
      maximum = Math.max(maximum, ++active);
      await held.promise;
      active--;
      return "old";
    });
    await vi.advanceTimersByTimeAsync(0);
    queue.reset();
    const newest = queue.schedule("cloud/org/new", async () => {
      maximum = Math.max(maximum, ++active);
      active--;
      return "new";
    });
    await vi.advanceTimersByTimeAsync(0);
    held.resolve("done");
    await vi.runAllTimersAsync();
    expect(maximum).toBe(1);
    expect(await old).toBeNull();
    expect(await newest).toBe("new");
    queue.reset();
  });

  it("cannot release a new owner's pause through a retired lease", async () => {
    vi.useFakeTimers();
    const queue = new DesignBackgroundWorkQueue(4, 0);
    const staleRelease = queue.pause();
    queue.reset();
    const release = queue.pause();
    const work = vi.fn(async () => "new-owner");
    const result = queue.schedule("cloud/org/frame", work);
    staleRelease();
    await vi.advanceTimersByTimeAsync(0);
    const prematureCalls = work.mock.calls.length;
    release();
    await vi.runAllTimersAsync();
    expect(prematureCalls).toBe(0);
    expect(await result).toBe("new-owner");
    queue.reset();
  });

  it("settles an obsolete caller once even when its producer fails later", async () => {
    vi.useFakeTimers();
    const queue = new DesignBackgroundWorkQueue(4, 0);
    const held = deferred<string>();
    const old = queue
      .schedule("cloud/org/frame", () => held.promise, { latest: true })
      .catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(0);
    const newest = queue.schedule("cloud/org/frame", async () => "new", {
      latest: true,
    });
    held.reject(new Error("retired producer failed"));
    await vi.runAllTimersAsync();
    expect(await old).toBeNull();
    expect(await newest).toBe("new");
    queue.reset();
  });

  it("ignores a retired idle callback without admitting the next owner", async () => {
    vi.useFakeTimers();
    const callbacks: Array<() => void> = [];
    vi.stubGlobal("window", {
      requestIdleCallback: (callback: () => void) => callbacks.push(callback),
      cancelIdleCallback: vi.fn(),
    });
    const queue = new DesignBackgroundWorkQueue(4, 0);
    const old = queue.schedule("local/old", async () => "old");
    await vi.advanceTimersByTimeAsync(0);
    queue.reset();
    const work = vi.fn(async () => "new");
    const newest = queue.schedule("cloud/org/new", work);
    await vi.advanceTimersByTimeAsync(0);
    callbacks[0]!();
    const prematureCalls = work.mock.calls.length;
    callbacks[1]!();
    await vi.runAllTimersAsync();
    expect(prematureCalls).toBe(0);
    expect(await old).toBeNull();
    expect(await newest).toBe("new");
    queue.reset();
  });

  it("bounds ten thousand distinct waiting requests and settles every caller", async () => {
    vi.useFakeTimers();
    const queue = new DesignBackgroundWorkQueue(32, 0);
    const release = queue.pause();
    const requests = Array.from({ length: 10_000 }, (_, index) =>
      queue.schedule(`owner/frame-${index}`, async () => index),
    );
    release();
    await vi.runAllTimersAsync();
    const results = await Promise.all(requests);
    expect(results.filter((value) => value !== null)).toEqual(
      Array.from({ length: 32 }, (_, index) => 9_968 + index),
    );
    expect(results.filter((value) => value === null)).toHaveLength(9_968);
    queue.reset();
  });

  it.each([0, -1, 1.5, NaN, Infinity, 33])(
    "rejects an invalid pending bound %s",
    (limit) => {
      expect(() => new DesignBackgroundWorkQueue(limit, 0)).toThrow(RangeError);
    },
  );

  it.each([-1, NaN, Infinity])(
    "rejects an invalid quiet period %s",
    (quiet) => {
      expect(() => new DesignBackgroundWorkQueue(4, quiet)).toThrow(RangeError);
    },
  );
});
