import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { CloudWorkspaceSetupWorker } from "./setup-worker.js";
import type { CloudWorkspaceProvider } from "./provider.js";

const workers = {
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
    let due = true;
    vi.spyOn(worker as unknown as { readNextDelayMs(): Promise<number | null> }, "readNextDelayMs")
      .mockImplementation(async () => due ? 0 : null);
    // Exercise the real start/stop loop without database/provider I/O.
    const tick = vi.spyOn(worker as unknown as { tick(periodic?: boolean): Promise<void> }, "tick")
      .mockImplementation(async () => { due = false; });
    const notify = () => { due = true; worker.notify(); };
    return { worker, tick, notify, makeDue: () => { due = true; } };
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
    const { worker, tick, notify, makeDue } = fixture();
    const stop = worker.start();
    await vi.advanceTimersByTimeAsync(0);
    const interval = 1_000;
    await vi.advanceTimersByTimeAsync(interval - 100);
    notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
    makeDue(); // New work whose notification was lost.
    await vi.advanceTimersByTimeAsync(100);
    expect(tick).toHaveBeenCalledTimes(3);
    makeDue();
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
    const { worker, tick, notify, makeDue } = fixture();
    tick.mockRejectedValueOnce(new Error("tick failed"));
    const stop = worker.start();
    await vi.advanceTimersByTimeAsync(0);
    notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
    makeDue();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(3);
    await stop();
  });
});

describe("lifecycle reconciler", () => {
  function fixture() {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      const result = { rows: [], rowCount: 0 };
      return /^BEGIN; /.test(sql) ? Array.from({ length: 5 }, () => result) : result;
    });
    const pool = { connect: async () => ({ query, release: vi.fn() }), query } as unknown as pg.Pool;
    const worker = new CloudWorkspaceReconciler({
      pool, provider: { name: "boat" } as CloudWorkspaceProvider, intervalMs: 5_000,
      jobAuditIntervalMs: 10 * 60_000, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const orphans = vi.spyOn(worker, "reconcileOrphansOnce").mockResolvedValue(0);
    const audit = vi.spyOn(worker, "auditJobs").mockResolvedValue({});
    const claims = () => statements.filter(sql => sql.includes("control_plane_jobs")).length;
    return { worker, statements, orphans, audit, claims };
  }

  it("claims jobs on a hint and never runs claims or due scans of its own", async () => {
    const { worker, statements, orphans, audit, claims } = fixture();
    const claim = vi.spyOn(worker, "runOnce");
    const drift = vi.spyOn(worker, "reconcileDriftOnce");
    const stop = worker.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(claims()).toBe(1);
    worker.notify();
    await vi.advanceTimersByTimeAsync(100);
    expect(claims()).toBe(2);
    expect(statements.length).toBe(claims());
    expect(claim).not.toHaveBeenCalled();
    expect(drift).not.toHaveBeenCalled();
    expect(orphans).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    await stop();
  });

  it("runs the inventory sweep each minute and the job audit at its jittered interval", async () => {
    const { worker, orphans, audit } = fixture();
    const stop = worker.start();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(orphans).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(orphans).toHaveBeenCalledTimes(1);
    // Jitter 0.5 places the first audit at 0.75 of its interval.
    await vi.advanceTimersByTimeAsync(7.5 * 60_000 - 65_000 - 6_000);
    expect(audit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(audit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(audit).toHaveBeenCalledTimes(2);
    await stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("scopes each job to its own workspace and reschedules it", async () => {
    const { worker } = fixture();
    const claim = vi.spyOn(worker, "runOnce").mockResolvedValueOnce(true).mockResolvedValue(false);
    const drift = vi.spyOn(worker, "reconcileDriftOnce").mockResolvedValue(false);
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    await worker.runJob({ kind: "cloud_lifecycle_intent", workspaceId, orgId: workspaceId, payload: {} });
    expect(claim.mock.calls).toEqual([[workspaceId], [workspaceId]]);
    await worker.runJob({ kind: "cloud_workspace_drift", workspaceId, orgId: workspaceId, payload: {} });
    expect(drift).toHaveBeenCalledWith(workspaceId);
    // A workspace job without its workspace never widens to every workspace.
    await worker.runJob({ kind: "cloud_lifecycle_intent", workspaceId: null, orgId: null, payload: {} });
    expect(claim).toHaveBeenCalledTimes(2);
  });
});
