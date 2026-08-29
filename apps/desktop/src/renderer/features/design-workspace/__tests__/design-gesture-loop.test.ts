import { describe, expect, it, vi } from "vitest";

import {
  createDesignGestureLoop,
  sameDesignGestureStyles,
} from "../design-gesture-loop";

/** A request whose settlement the test controls, so the interleavings a real
 * pointer produces can be reproduced exactly. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

/** Let every already-settled promise callback run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createDesignGestureLoop", () => {
  it("keeps one request in flight and dispatches only the newest authored styles", async () => {
    const pending: Array<ReturnType<typeof deferred<string>>> = [];
    const requested: Array<Record<string, string>> = [];
    const measured: string[] = [];
    const loop = createDesignGestureLoop<string>({
      request: (styles) => {
        requested.push(styles);
        const next = deferred<string>();
        pending.push(next);
        return next.promise;
      },
      measured: (value) => measured.push(value),
    });

    loop.author({ width: "10px" });
    loop.author({ width: "20px" });
    loop.author({ width: "30px" });
    expect(requested).toEqual([{ width: "10px" }]);

    pending[0]!.resolve("10");
    await flush();
    // The two intermediate samples collapse into one dispatch of the newest.
    expect(requested).toEqual([{ width: "10px" }, { width: "30px" }]);
    expect(loop.stats).toMatchObject({
      revisions: 3,
      requests: 2,
      coalesced: 1,
    });
    // Single flight means the element still holds exactly what request one
    // applied, so its measurement describes the element as it stands.
    expect(measured).toEqual(["10"]);

    pending[1]!.resolve("30");
    await loop.settled();
    expect(measured).toEqual(["10", "30"]);
  });

  it("delivers a measurement that still describes the newest authored styles", async () => {
    const pending: Array<ReturnType<typeof deferred<string>>> = [];
    const measured: string[] = [];
    const loop = createDesignGestureLoop<string>({
      request: () => {
        const next = deferred<string>();
        pending.push(next);
        return next.promise;
      },
      measured: (value) => measured.push(value),
    });

    loop.author({ height: "40px" });
    pending[0]!.resolve("40");
    await loop.settled();
    expect(measured).toEqual(["40"]);
  });

  it("never calls back after stop, including for an in-flight request", async () => {
    const pending = deferred<string>();
    const measured: string[] = [];
    const failed: unknown[] = [];
    const loop = createDesignGestureLoop<string>({
      request: () => pending.promise,
      measured: (value) => measured.push(value),
      failed: (error) => failed.push(error),
    });

    loop.author({ top: "1px" });
    loop.stop();
    loop.author({ top: "2px" });
    pending.resolve("1");
    await loop.settled();
    expect(measured).toEqual([]);
    expect(failed).toEqual([]);
    expect(loop.stats.requests).toBe(1);
  });

  it("reports a failure without stopping the gesture", async () => {
    const results: Array<ReturnType<typeof deferred<string>>> = [];
    const failed: unknown[] = [];
    const measured: string[] = [];
    const loop = createDesignGestureLoop<string>({
      request: () => {
        const next = deferred<string>();
        results.push(next);
        return next.promise;
      },
      measured: (value) => measured.push(value),
      failed: (error) => failed.push(error),
    });

    loop.author({ left: "5px" });
    results[0]!.reject(new Error("stale generation"));
    await loop.settled();
    expect(failed).toHaveLength(1);

    loop.author({ left: "6px" });
    results[1]!.resolve("6");
    await loop.settled();
    expect(measured).toEqual(["6"]);
  });

  it("drains queued styles authored while a request was in flight", async () => {
    const results: Array<ReturnType<typeof deferred<string>>> = [];
    const requested: Array<Record<string, string>> = [];
    const loop = createDesignGestureLoop<string>({
      request: (styles) => {
        requested.push(styles);
        const next = deferred<string>();
        results.push(next);
        return next.promise;
      },
    });

    loop.author({ gap: "1px" });
    loop.author({ gap: "2px" });
    results[0]!.resolve("1");
    await flush();
    expect(requested).toEqual([{ gap: "1px" }, { gap: "2px" }]);
    results[1]!.resolve("2");
    await loop.settled();
    expect(loop.stats.requests).toBe(2);
  });

  it("swallows a failure when the gesture asked for no failure handler", async () => {
    const rejected = deferred<string>();
    const loop = createDesignGestureLoop<string>({
      request: () => rejected.promise,
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    loop.author({ width: "9px" });
    rejected.reject(new Error("gone"));
    await loop.settled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("sameDesignGestureStyles", () => {
  /** At 8× zoom a screen pixel is an eighth of a CSS one, so consecutive
   * pointer samples keep authoring the integers the element already carries.
   * Recognising those is what keeps a slow drag from spending a round trip and
   * a layout flush per frame to be told nothing moved. */
  it("recognises a pointer sample that authors no change", () => {
    expect(
      sameDesignGestureStyles(
        { left: "10px", width: "40px" },
        { left: "10px", width: "40px" },
      ),
    ).toBe(true);
    expect(
      sameDesignGestureStyles(
        { left: "10px", width: "40px" },
        { left: "11px", width: "40px" },
      ),
    ).toBe(false);
  });

  it("treats a changed property set as a change even at equal length", () => {
    expect(sameDesignGestureStyles({ width: "40px" }, { height: "40px" })).toBe(
      false,
    );
    expect(sameDesignGestureStyles({}, { width: "40px" })).toBe(false);
    expect(sameDesignGestureStyles({ width: "40px" }, {})).toBe(false);
  });
});
