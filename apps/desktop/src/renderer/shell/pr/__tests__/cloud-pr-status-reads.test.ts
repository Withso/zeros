import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudPrStatusReads } from "../cloud-pr-status-reads";
import type { PR, PrChecksResult } from "../../../platform/git";

type Result = [PromiseSettledResult<PR>, PromiseSettledResult<PrChecksResult>];
const success = (number = 42): Result => [{ status: "fulfilled", value: { number } as PR },
  { status: "fulfilled", value: { checks: [] } as unknown as PrChecksResult }];
const failure = (): Result => [{ status: "rejected", reason: new Error("unavailable") }, success()[1]];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });

describe("cloud PR observation cadence", () => {
  it("shares only the exact workspace/PR flight and keeps A-B-A isolated", async () => {
    const cache = new CloudPrStatusReads();
    let release!: (result: Result) => void;
    const load = vi.fn(() => new Promise<Result>(resolve => { release = resolve; }));
    const first = cache.read("cloud://a/workspace#42", load);
    expect(cache.read("cloud://a/workspace#42", load)).toBe(first);
    await cache.read("cloud://b/workspace#42", async () => success(99));
    release(success()); await expect(first).resolves.toEqual(success());
    await expect(cache.read("cloud://a/workspace#42", load)).resolves.toEqual(success());
    expect(load).toHaveBeenCalledOnce();
  });
  it("backs failures off to five minutes, then restores the healthy 30-second cadence", async () => {
    const cache = new CloudPrStatusReads(), load = vi.fn(async () => failure());
    for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
      await cache.read("workspace#42", load);
      const count = load.mock.calls.length;
      vi.advanceTimersByTime(delay - 1); await cache.read("workspace#42", load);
      expect(load).toHaveBeenCalledTimes(count);
      vi.advanceTimersByTime(1);
    }
    load.mockResolvedValue(success()); await cache.read("workspace#42", load);
    const count = load.mock.calls.length;
    vi.advanceTimersByTime(29_999); await cache.read("workspace#42", load);
    expect(load).toHaveBeenCalledTimes(count);
    vi.advanceTimersByTime(1); await cache.read("workspace#42", load);
    expect(load).toHaveBeenCalledTimes(count + 1);
  });
  it("cannot reinstall a deleted observation or overwrite a post-mutation successor", async () => {
    const cache = new CloudPrStatusReads();
    let release!: (result: Result) => void;
    const previous = cache.read("workspace#42", () => new Promise<Result>(resolve => { release = resolve; }));
    await Promise.resolve(); cache.forgetWorkspace("workspace");
    await cache.read("workspace#42", async () => success(43));
    release(success()); expect((await previous).every(value => value.status === "rejected")).toBe(true);
    const load = vi.fn(async () => success());
    await expect(cache.read("workspace#42", load)).resolves.toEqual(success(43));
    expect(load).not.toHaveBeenCalled();
    cache.forget("workspace#42"); await cache.read("workspace#42", load);
    expect(load).toHaveBeenCalledOnce();
  });
  it("bounds settled retention and refuses excess pending keys without starting more work", async () => {
    const cache = new CloudPrStatusReads(), load = vi.fn(async () => success());
    for (let index = 0; index < 65; index++) await cache.read(`${index}#42`, load);
    await cache.read("0#42", load); expect(load).toHaveBeenCalledTimes(66);
    const pending = new CloudPrStatusReads();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const flights = Array.from({ length: 64 }, (_, index) => pending.read(`${index}#42`, async () => { await held; return success(); }));
    const overflow = vi.fn(async () => success());
    expect((await pending.read("overflow#42", overflow)).every(value => value.status === "rejected")).toBe(true);
    expect(overflow).not.toHaveBeenCalled(); release(); await Promise.all(flights);
    await pending.read("overflow#42", overflow); expect(overflow).toHaveBeenCalledOnce();
  });
});
