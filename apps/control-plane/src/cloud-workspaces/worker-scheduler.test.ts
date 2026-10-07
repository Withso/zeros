import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudWorkerScheduler } from "./worker-scheduler.js";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("cloud worker durable deadlines", () => {
  it("preserves notification and periodic behavior for workers without a deadline source", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const worker = new CloudWorkerScheduler(5_000, run, vi.fn());
    worker.start(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500); worker.notify();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(run.mock.calls).toEqual([[true], [false], [true]]);
    await worker.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it("claims at a future durable deadline without waiting for the periodic scan", async () => {
    const run = vi.fn().mockResolvedValue(undefined), error = vi.fn();
    const deadline = vi.fn().mockResolvedValueOnce(250).mockResolvedValue(null);
    const worker = new CloudWorkerScheduler(5_000, run, error, deadline);
    worker.start(); await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledExactlyOnceWith(true);
    await vi.advanceTimersByTimeAsync(249); expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(run.mock.calls).toEqual([[true], [false]]);
    await vi.advanceTimersByTimeAsync(4_750); expect(run.mock.calls).toEqual([[true], [false], [true]]);
    expect(error).not.toHaveBeenCalled(); await worker.stop();
  });

  it("refreshes an earlier deadline after a coalesced notification without moving maintenance", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const deadline = vi.fn().mockResolvedValueOnce(4_000).mockResolvedValueOnce(100).mockResolvedValue(null);
    const worker = new CloudWorkerScheduler(5_000, run, vi.fn(), deadline);
    worker.start(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    for (let i = 0; i < 50; i++) worker.notify();
    await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100); expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4_400);
    expect(run.mock.calls).toEqual([[true], [false], [false], [true]]);
    await worker.stop();
  });

  it("keeps one pending hint during a long tick and never overlaps claims", async () => {
    const active = deferred();
    const run = vi.fn().mockReturnValueOnce(active.promise).mockResolvedValue(undefined);
    const worker = new CloudWorkerScheduler(5_000, run, vi.fn(), async () => null);
    worker.start(); await vi.advanceTimersByTimeAsync(0);
    worker.notify(); worker.notify();
    await vi.advanceTimersByTimeAsync(2_000); expect(run).toHaveBeenCalledOnce();
    active.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    await worker.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not postpone the periodic scan while reading a durable deadline", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockImplementationOnce(() => new Promise<null>(resolve => setTimeout(() => resolve(null), 2_000)))
      .mockResolvedValue(null);
    const worker = new CloudWorkerScheduler(5_000, run, vi.fn(), read);
    worker.start(); await vi.advanceTimersByTimeAsync(5_000);
    expect(run.mock.calls).toEqual([[true], [true]]);
    await worker.stop();
  });

  it("bounds already-due or locked work instead of spinning", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const worker = new CloudWorkerScheduler(5_000, run, vi.fn(), async () => 0);
    worker.start(); await vi.advanceTimersByTimeAsync(99); expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
    await worker.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["query failure", "no eligible work", "invalid delay"])("retains periodic fallback for %s", async kind => {
    const run = vi.fn().mockResolvedValue(undefined), error = vi.fn();
    const read = vi.fn().mockImplementation(async () => {
      if (kind === "query failure") throw new Error("database unavailable");
      return kind === "invalid delay" ? NaN : null;
    });
    const worker = new CloudWorkerScheduler(5_000, run, error, read);
    worker.start(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_999); expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(run.mock.calls).toEqual([[true], [true]]);
    if (kind === "query failure") expect(error).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it("does not arm a deadline after stop while the deadline read is pending", async () => {
    let finish!: (delay: number) => void;
    const read = new Promise<number>(resolve => { finish = resolve; });
    const run = vi.fn().mockResolvedValue(undefined);
    const worker = new CloudWorkerScheduler(5_000, run, vi.fn(), () => read);
    worker.start(); await vi.advanceTimersByTimeAsync(0);
    const stopping = worker.stop(); finish(250); await stopping;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
