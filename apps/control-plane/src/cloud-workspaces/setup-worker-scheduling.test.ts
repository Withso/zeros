import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudWorkspaceSetupWorker } from "./setup-worker.js";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async original => ({
  ...await original<typeof import("../db.js")>(),
  withSystemTx: async (_pool: unknown, run: (tx: unknown) => Promise<unknown>) => run({ query: db.query }),
}));

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); db.query.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// Exercise the real start/notify/deadline/dispatch loop. Only the durable claim
// and long execution seams are controlled here; PostgreSQL fencing, readiness,
// heartbeat and cancellation are covered by setup-worker.integration.test.ts.
function harness(count: number, concurrency = 2) {
  const queued = Array.from({ length: count }, () => ({ workspaceId: randomUUID() }));
  const gates: ReturnType<typeof deferred>[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const worker = new CloudWorkspaceSetupWorker({ pool: {} as pg.Pool, executor: { execute: vi.fn() },
    sanitizeLog: value => value, intervalMs: 60_000, concurrency, logger });
  const seams = worker as unknown as {
    claim(): Promise<{ kind: "none" } | { kind: "claimed"; setup: { workspaceId: string } }>;
    execute(): Promise<void>;
  };
  db.query.mockImplementation(async () => ({ rows: [{ delay_ms: queued.length ? "0" : null }] }));
  const claim = vi.spyOn(seams, "claim").mockImplementation(async () => {
    const setup = queued.shift();
    return setup ? { kind: "claimed", setup } : { kind: "none" };
  });
  const execute = vi.spyOn(seams, "execute").mockImplementation(() => {
    const gate = deferred(); gates.push(gate); return gate.promise;
  });
  return { worker, queued, gates, claim, execute, logger, close: async () => {
    const stopped = worker.stop();
    for (const gate of gates) gate.resolve();
    await stopped;
  } };
}

describe("setup execution scheduler", () => {
  it("does no queue polling while full, refills immediately, and retains only the quiet fallback after drain", async () => {
    const f = harness(3);
    f.worker.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.execute).toHaveBeenCalledTimes(2);
      const reads = db.query.mock.calls.length, claims = f.claim.mock.calls.length;
      for (let index = 0; index < 50; index++) f.worker.notify();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(db.query).toHaveBeenCalledTimes(reads);
      expect(f.claim).toHaveBeenCalledTimes(claims);
      expect(await f.worker.runOnce()).toBe(false);
      f.gates[1]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.execute).toHaveBeenCalledTimes(3);
      f.gates[0]!.resolve(); f.gates[2]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      const drainedReads = db.query.mock.calls.length;
      await vi.advanceTimersByTimeAsync(54_999);
      expect(db.query).toHaveBeenCalledTimes(drainedReads);
      await vi.advanceTimersByTimeAsync(1);
      expect(db.query).toHaveBeenCalledTimes(drainedReads + 1);
      expect(f.claim).toHaveBeenCalledTimes(claims + 1);
    } finally { await f.close(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a notification arriving during a pending claim", async () => {
    const f = harness(1), gate = deferred();
    const claim = f.claim.getMockImplementation()!;
    f.claim.mockImplementationOnce(async () => { const result = await claim(); await gate.promise; return result; });
    f.worker.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      f.queued.push({ workspaceId: randomUUID() }); f.worker.notify(); f.worker.notify();
      gate.resolve(); await vi.advanceTimersByTimeAsync(0);
      expect(f.execute).toHaveBeenCalledTimes(2);
    } finally { gate.resolve(); await f.close(); }
  });

  it("releases a failed execution slot without logging exception text or waiting for the other execution", async () => {
    const f = harness(3);
    f.worker.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.execute).toHaveBeenCalledTimes(2);
      f.gates[1]!.reject(new Error("private-provider-output"));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.execute).toHaveBeenCalledTimes(3);
      expect(f.logger.error).toHaveBeenCalledExactlyOnceWith("[cloud-workspace] setup execution failed; will retry");
    } finally { await f.close(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("supports a serial rollback while keeping completion-driven refill", async () => {
    const f = harness(2, 1);
    f.worker.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.execute).toHaveBeenCalledOnce();
      const attempt = f.worker.runOnce();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.execute).toHaveBeenCalledOnce();
      expect(await attempt).toBe(false);
      f.gates[0]!.resolve(); await vi.advanceTimersByTimeAsync(0);
      expect(f.execute).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });

  it.each([0, 9, 1.5, NaN, Infinity])("refuses an invalid direct concurrency option %s", concurrency => {
    expect(() => harness(0, concurrency)).toThrow("concurrency must be between 1 and 8");
  });
});
