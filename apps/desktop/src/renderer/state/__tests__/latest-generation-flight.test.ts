import { describe, expect, it, vi } from "vitest";

import { LatestGenerationFlight } from "../../shared/lib/latest-generation-flight";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("LatestGenerationFlight", () => {
  it("shares one request for concurrent callers in the same generation", async () => {
    const flights = new LatestGenerationFlight<string>();
    const request = deferred<string>();
    const fetcher = vi.fn(() => request.promise);

    const first = flights.run("workspace-a", 1, fetcher);
    const second = flights.run("workspace-a", 1, fetcher);
    await Promise.resolve();

    expect(fetcher).toHaveBeenCalledTimes(1);
    request.resolve("ready");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "ready",
      "ready",
    ]);
  });

  it("bounds an invalidation burst to one running and one latest follow-up", async () => {
    const flights = new LatestGenerationFlight<string>();
    const first = deferred<string>();
    const latest = deferred<string>();
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;

    const request = (generation: number, value: Promise<string>) => () => {
      started.push(generation);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return value.finally(() => {
        active -= 1;
      });
    };

    const old = flights.run("workspace-a", 1, request(1, first.promise));
    const superseded = flights.run(
      "workspace-a",
      2,
      request(2, Promise.resolve("must-not-run")),
    );
    const newest = flights.run("workspace-a", 99, request(99, latest.promise));
    await Promise.resolve();

    expect(started).toEqual([1]);
    first.resolve("stale");
    await expect(old).resolves.toBe("stale");
    await vi.waitFor(() => expect(started).toEqual([1, 99]));
    expect(maxActive).toBe(1);

    latest.resolve("fresh");
    await expect(Promise.all([superseded, newest])).resolves.toEqual([
      "fresh",
      "fresh",
    ]);
  });

  it("starts a queued successor even when the superseded request fails", async () => {
    const flights = new LatestGenerationFlight<string>();
    const first = deferred<string>();
    const second = deferred<string>();
    const firstFetcher = vi.fn(() => first.promise);
    const secondFetcher = vi.fn(() => second.promise);

    const stale = flights.run("workspace-a", 1, firstFetcher);
    const fresh = flights.run("workspace-a", 2, secondFetcher);
    await Promise.resolve();
    first.reject(new Error("old generation failed"));

    await expect(stale).rejects.toThrow("old generation failed");
    await vi.waitFor(() => expect(secondFetcher).toHaveBeenCalledOnce());
    second.resolve("fresh");
    await expect(fresh).resolves.toBe("fresh");
  });

  it("does not serialize independent exact keys", async () => {
    const flights = new LatestGenerationFlight<string>();
    const left = deferred<string>();
    const right = deferred<string>();
    const leftFetcher = vi.fn(() => left.promise);
    const rightFetcher = vi.fn(() => right.promise);

    const leftRead = flights.run("workspace-a", 1, leftFetcher);
    const rightRead = flights.run("workspace-b", 1, rightFetcher);
    await Promise.resolve();

    expect(leftFetcher).toHaveBeenCalledOnce();
    expect(rightFetcher).toHaveBeenCalledOnce();
    left.resolve("left");
    right.resolve("right");
    await expect(Promise.all([leftRead, rightRead])).resolves.toEqual([
      "left",
      "right",
    ]);
  });
});
