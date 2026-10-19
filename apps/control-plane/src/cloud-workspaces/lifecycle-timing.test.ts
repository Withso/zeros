import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withLifecycleTiming, measureLifecyclePhase, readLifecycleTiming, recordLifecycleDatabaseElapsed,
} from "./lifecycle-timing.js";

afterEach(() => vi.restoreAllMocks());

describe("lifecycle phase timing", () => {
  it("separates nested funding and post-dispatch work using only the monotonic clock", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const wall = vi.spyOn(Date, "now").mockReturnValue(1000);
    const timing = await withLifecycleTiming(async () => {
      await measureLifecyclePhase("dispatch", async () => {
        now += 5;
        await measureLifecyclePhase("funding", async () => { now += 7; wall.mockReturnValue(-100_000); });
        now += 3;
        await measureLifecyclePhase("postDispatchObservation", async () => { now += 11; wall.mockReturnValue(999_000); });
        now += 2;
      });
      return readLifecycleTiming();
    });
    expect(timing).toEqual({ version: 1, monotonicMs: { dispatch: 10, funding: 7, postDispatchObservation: 11 }, databaseElapsedMs: {} });
  });

  it("keeps concurrent attempts and failed phases isolated", async () => {
    let now = 0, release!: () => void, reached!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const first = withLifecycleTiming(async () => {
      await measureLifecyclePhase("inspect", async () => {
        reached(); await new Promise<void>(resolve => { release = resolve; });
      });
      return readLifecycleTiming();
    });
    await entered;
    now = 10;
    const second = await withLifecycleTiming(async () => {
      await expect(measureLifecyclePhase("dispatch", async () => { now = 20; throw new Error("fixture"); })).rejects.toThrow("fixture");
      return readLifecycleTiming();
    });
    now = 30; release();
    expect(await first).toEqual({ version: 1, monotonicMs: { inspect: 30 }, databaseElapsedMs: {} });
    expect(second).toEqual({ version: 1, monotonicMs: { dispatch: 10 }, databaseElapsedMs: {} });
    expect(readLifecycleTiming()).toBeUndefined();
  });

  it("excludes overlapping child time once and freezes the pre-audit boundary", async () => {
    let now = 0, releaseFunding!: () => void, releaseObservation!: () => void;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const timing = await withLifecycleTiming(async () => {
      await measureLifecyclePhase("dispatch", async () => {
        now = 5;
        const funding = measureLifecyclePhase("funding", () => new Promise<void>(resolve => { releaseFunding = resolve; }));
        now = 7;
        const observation = measureLifecyclePhase("postDispatchObservation", () => new Promise<void>(resolve => { releaseObservation = resolve; }));
        now = 10; releaseFunding(); await funding;
        now = 12; releaseObservation(); await observation;
        now = 15;
      });
      const resultStarted = now;
      now = 22;
      const snapshot = readLifecycleTiming(resultStarted);
      now = 100; // Subsequent audit/COMMIT time does not rewrite the snapshot.
      return snapshot;
    });
    expect(timing).toEqual({ version: 1, monotonicMs: {
      dispatch: 8, funding: 5, postDispatchObservation: 5, resultWritePrecommit: 7,
    }, databaseElapsedMs: {} });
    expect(Object.isFrozen(timing)).toBe(true);
    expect(Object.isFrozen(timing?.monotonicMs)).toBe(true);
  });

  it("caps finite values, omits invalid samples and never emits arbitrary labels", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const timing = await withLifecycleTiming(async () => {
      await measureLifecyclePhase("inspect", async () => { now = 100_000_000; });
      await measureLifecyclePhase("private-provider-id" as never, async () => { now += 1; });
      recordLifecycleDatabaseElapsed("firstClaimWait", -100);
      recordLifecycleDatabaseElapsed("previousLeaseWait", Infinity);
      recordLifecycleDatabaseElapsed("private-workspace-id" as never, 123);
      return readLifecycleTiming();
    });
    expect(timing).toEqual({ version: 1, monotonicMs: { inspect: 86_400_000 }, databaseElapsedMs: { firstClaimWait: 0 } });
  });

  it("ignores late detached measurements after an attempt closes", async () => {
    let now = 0, release!: () => void, detached!: Promise<unknown>;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const timing = await withLifecycleTiming(async () => {
      detached = measureLifecyclePhase("inspect", async () => {
        await new Promise<void>(resolve => { release = resolve; });
        recordLifecycleDatabaseElapsed("previousLeaseWait", 999);
      });
      return readLifecycleTiming();
    });
    now = 10; release(); await detached;
    expect(timing).toEqual({ version: 1, monotonicMs: {}, databaseElapsedMs: {} });
    expect(readLifecycleTiming()).toBeUndefined();
  });
});
