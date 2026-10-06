import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { CloudWorkspaceSetupWorker } from "./setup-worker.js";
import type { CloudWorkspaceProvider } from "./provider.js";

const workers = {
  lifecycle: () => new CloudWorkspaceReconciler({
    pool: {} as pg.Pool, provider: { name: "boat" } as CloudWorkspaceProvider,
    intervalMs: 5_000, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }),
  setup: () => new CloudWorkspaceSetupWorker({
    pool: {} as pg.Pool, executor: { execute: vi.fn() },
    sanitizeLog: value => value, intervalMs: 1_000,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }),
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each(Object.entries(workers))("%s work scheduling", (_name, makeWorker) => {
  function fixture() {
    vi.useFakeTimers();
    const worker = makeWorker();
    // Exercise the real start/stop loop without database/provider I/O.
    const tick = vi.spyOn(worker as unknown as { tick(periodic?: boolean): Promise<void> }, "tick")
      .mockResolvedValue(undefined);
    const notify = () => (worker as unknown as { notify(): void }).notify();
    return { worker, tick, notify };
  }

  it("runs committed work immediately instead of waiting for the poll", async () => {
    const { worker, tick, notify } = fixture();
    const stop = worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
    await stop();
  });

  it("coalesces notices during a tick and never overlaps execution", async () => {
    const { worker, tick, notify } = fixture();
    let release!: () => void;
    tick.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const stop = worker.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 50; i++) notify();
    await vi.advanceTimersByTimeAsync(10);
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
    await stop();
  });

  it("keeps polling even when notifications are absent or frequent", async () => {
    const { worker, tick, notify } = fixture();
    const stop = worker.start();
    await vi.advanceTimersByTimeAsync(0);
    const interval = _name === "lifecycle" ? 5_000 : 1_000;
    await vi.advanceTimersByTimeAsync(interval - 100);
    notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(tick).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(interval);
    expect(tick).toHaveBeenCalledTimes(4);
    await stop();
  });

  it("drains an active tick and drops pending notices on shutdown", async () => {
    const { worker, tick, notify } = fixture();
    let release!: () => void;
    tick.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const stop = worker.start();
    await vi.advanceTimersByTimeAsync(0);
    notify();
    const stopped = vi.fn();
    const stopping = stop().then(stopped);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).not.toHaveBeenCalled();
    release();
    await stopping;
    notify();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues polling after a failed tick", async () => {
    const { worker, tick, notify } = fixture();
    tick.mockRejectedValueOnce(new Error("tick failed"));
    const stop = worker.start();
    await vi.advanceTimersByTimeAsync(0);
    notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(_name === "lifecycle" ? 5_000 : 1_000);
    expect(tick).toHaveBeenCalledTimes(3);
    await stop();
  });
});

it("notification ticks do not advance lifecycle maintenance or orphan sweeps", async () => {
  const worker = workers.lifecycle();
  const claim = vi.spyOn(worker, "runOnce").mockResolvedValue(false);
  const drift = vi.spyOn(worker, "reconcileDriftOnce").mockResolvedValue(false);
  const orphans = vi.spyOn(worker, "reconcileOrphansOnce").mockResolvedValue(0);
  const internal = worker as unknown as { tick(periodic: boolean): Promise<void> };
  // The fixture has no database. Any maintenance/lease/authority read fails.
  for (let i = 0; i < 24; i++) await internal.tick(false);
  expect(claim).toHaveBeenCalledTimes(24);
  expect(drift).not.toHaveBeenCalled();
  expect(orphans).not.toHaveBeenCalled();
});
