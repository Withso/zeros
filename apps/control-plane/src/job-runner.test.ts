import { EventEmitter } from "node:events";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobRunner, type JobHandler } from "./job-runner.js";

type Operation = "claim" | "complete" | "fail" | "extend" | "release" | "purge";
type Result = { rows?: unknown[]; rowCount?: number };
type Script = Partial<Record<Operation, (call: number) => Promise<Result>>>;

function operationOf(statement: string): Operation {
  if (statement.includes("WITH policy(kind, lease_ms)")) return "claim";
  if (statement.includes("WITH target AS")) return "complete";
  if (statement.includes("FROM (VALUES")) return "release";
  if (statement.includes("DELETE FROM control_plane_jobs WHERE id IN")) return "purge";
  if (statement.includes("last_error_code =")) return "fail";
  return "extend";
}

/** A pool that answers queue batches from a script. Times are fake-clock
 * `performance.now()` values taken when each batch is sent. */
function scriptedPool(script: Script) {
  const calls: { operation: Operation; at: number; statement: string }[] = [];
  const counts = new Map<Operation, number>();
  const client = {
    query: async (text: string) => {
      if (text === "ROLLBACK") return {};
      const statement = text.split("SELECT set_config('app.system', 'on', true); ")[1] ?? "";
      const operation = operationOf(statement);
      const call = counts.get(operation) ?? 0;
      counts.set(operation, call + 1);
      calls.push({ operation, at: performance.now(), statement });
      const result = await (script[operation]?.(call) ?? Promise.resolve({ rows: [], rowCount: 0 }));
      const empty = { command: "SELECT", rows: [], rowCount: 0 };
      return [empty, empty, empty, { command: "UPDATE", rows: [], rowCount: result.rows?.length ?? 0, ...result }, empty];
    },
    release: () => {},
    on: () => client,
    once: () => client,
    removeListener: () => client,
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { pool, calls, count: (operation: Operation) => calls.filter(entry => entry.operation === operation).length };
}

function claimRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, kind: "test_kind", dedupe_key: id, org_id: null, workspace_id: null, payload: {}, state: "running",
    attempts: 1, max_attempts: 10, lease_token: "00000000-0000-4000-8000-000000000001",
    locked_until: new Date(), run_at: new Date(), created_at: new Date(), next_due_ms: null, ...overrides,
  };
}
const JOB_ID = "00000000-0000-4000-8000-0000000000aa";
const claimed = (overrides: Record<string, unknown> = {}) => Promise.resolve({ rows: [claimRow(JOB_ID, overrides)] });
const nothingDue = () => Promise.resolve({ rows: [{ ...claimRow(JOB_ID), id: null }] });
const delayed = <T>(ms: number, value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));
const rejected = (error: unknown = new Error("unavailable")) => Promise.reject(error);

describe("job runner timing", () => {
  const runners: JobRunner[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  });
  afterEach(async () => {
    const stopping = Promise.all(runners.splice(0).map(runner => runner.stop()));
    await vi.advanceTimersByTimeAsync(200_000);
    await stopping;
    vi.useRealTimers();
  });
  const runner = (pool: pg.Pool, handler: Omit<JobHandler, "kind">, options: Partial<ConstructorParameters<typeof JobRunner>[0]> = {}) => {
    const created = new JobRunner({ pool, pollIntervalMs: 300_000, logger: { warn: () => {} }, ...options,
      handlers: [{ kind: "test_kind", leaseMs: 30_000, ...handler }] });
    runners.push(created);
    return created;
  };
  const waitForAbort = (signal: AbortSignal, record: (at: number) => void) => new Promise<void>(resolve => {
    signal.addEventListener("abort", () => { record(performance.now()); resolve(); }, { once: true });
  });

  it("aborts at the local lease deadline, anchored at the claim request, when extensions fail", async () => {
    const fake = scriptedPool({
      claim: call => call === 0 ? delayed(5_000, { rows: [claimRow(JOB_ID)] }) : nothingDue(),
      extend: () => rejected(),
    });
    let abortedAt: number | undefined;
    runner(fake.pool, { handle: async (_job, { signal }) => waitForAbort(signal, at => { abortedAt = at; }) }).start();
    await vi.advanceTimersByTimeAsync(100);
    const claimSentAt = fake.calls.find(entry => entry.operation === "claim")!.at;
    // The 30 s lease is presumed lost 3 s early, counted from the claim
    // request rather than its 5 s late response.
    await vi.advanceTimersByTimeAsync(claimSentAt + 26_999 - performance.now());
    expect(abortedAt).toBeUndefined();
    expect(fake.count("extend")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(abortedAt).toBe(claimSentAt + 27_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.count("complete") + fake.count("fail")).toBe(0);
  });

  it("refreshes the local deadline from the start of a confirmed extension request", async () => {
    const fake = scriptedPool({
      claim: call => call === 0 ? claimed() : nothingDue(),
      extend: call => call === 0 ? delayed(4_000, { rowCount: 1 }) : rejected(),
    });
    let abortedAt: number | undefined;
    runner(fake.pool, { handle: async (_job, { signal }) => waitForAbort(signal, at => { abortedAt = at; }) }).start();
    await vi.advanceTimersByTimeAsync(40_000);
    const extensions = fake.calls.filter(entry => entry.operation === "extend");
    expect(extensions).toHaveLength(2);
    expect(abortedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(extensions[0]!.at + 26_999 - performance.now());
    expect(abortedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(abortedAt).toBe(extensions[0]!.at + 27_000);
    expect(fake.count("complete") + fake.count("fail")).toBe(0);
  });

  it("extends a held lease at half its length and aborts when an extension reports it lost", async () => {
    const fake = scriptedPool({
      claim: call => call === 0 ? claimed() : nothingDue(),
      extend: call => Promise.resolve({ rowCount: call < 3 ? 1 : 0 }),
    });
    let abortedAt: number | undefined;
    runner(fake.pool, { handle: async (_job, { signal }) => waitForAbort(signal, at => { abortedAt = at; }) }).start();
    await vi.advanceTimersByTimeAsync(100);
    const started = fake.calls[0]!.at;
    await vi.advanceTimersByTimeAsync(50_000);
    expect(fake.calls.filter(entry => entry.operation === "extend").map(entry => entry.at - started))
      .toEqual([15_000, 30_000, 45_000].map(at => expect.closeTo(at, -1)));
    expect(abortedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(abortedAt).toBeCloseTo(started + 60_000, -1);
    expect(fake.count("complete") + fake.count("fail")).toBe(0);
  });

  it("keeps the claim-error delay when hints arrive, and logs only a closed code", async () => {
    const fake = scriptedPool({
      claim: call => call === 0 ? rejected(new Error("password=hunter2 at 10.0.0.1"))
        : call === 1 ? rejected(Object.assign(new Error("terminating connection"), { code: "57P01" }))
        : nothingDue(),
    });
    const warn = vi.fn();
    const instance = runner(fake.pool, { handle: async () => {} }, { logger: { warn } });
    instance.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.count("claim")).toBe(1);
    const failedAt = fake.calls[0]!.at;
    for (let index = 0; index < 5; index++) {
      instance.notify();
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(fake.count("claim")).toBe(1);
    await vi.advanceTimersByTimeAsync(failedAt + 5_000 - performance.now() + 100);
    expect(fake.count("claim")).toBe(2);
    expect(fake.calls[1]!.at - failedAt).toBeGreaterThanOrEqual(5_000);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fake.count("claim")).toBe(3);
    expect(warn.mock.calls.map(call => call[0])).toEqual([
      "[jobs] claim failed (claim_failed); will retry",
      "[jobs] claim failed (database_unavailable); will retry",
    ]);
  });

  it("does not release a lease whose completion is already in flight at shutdown", async () => {
    let finishCompletion!: () => void;
    const fake = scriptedPool({
      claim: call => call === 0 ? claimed() : nothingDue(),
      complete: () => new Promise(resolve => { finishCompletion = () => resolve({ rows: [{ requeued: 0, deleted: 1 }] }); }),
    });
    const instance = runner(fake.pool, { handle: async () => {} }, { drainTimeoutMs: 100 });
    instance.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.count("complete")).toBe(1);
    const stopping = instance.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.count("release")).toBe(0);
    finishCompletion();
    await stopping;
    expect(fake.count("release")).toBe(0);
    expect(instance.inFlight).toBe(0);
  });

  it("wakes once for a requeued completion and the trigger hint that follows it", async () => {
    let instance!: JobRunner;
    const fake = scriptedPool({
      claim: call => call < 2 ? claimed() : nothingDue(),
      complete: call => {
        if (call === 0) setTimeout(() => instance.notify(), 1);
        return Promise.resolve({ rows: [{ requeued: call === 0 ? 1 : 0, deleted: call === 0 ? 0 : 1 }] });
      },
    });
    instance = runner(fake.pool, { handle: async () => {} });
    instance.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.calls.map(entry => entry.operation)).toEqual(["claim", "complete", "claim", "complete"]);
  });

  it("coalesces a burst of hints into one claim", async () => {
    const fake = scriptedPool({ claim: () => nothingDue() });
    const instance = runner(fake.pool, { handle: async () => {} });
    instance.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.count("claim")).toBe(1);
    for (let index = 0; index < 20; index++) instance.notify();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.count("claim")).toBe(2);
  });

  it("logs notification unavailability once per outage", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let session: (EventEmitter & { query: () => Promise<unknown>; release: () => void }) | undefined;
    let available = false;
    const listenerPool = {
      connect: async () => {
        if (!available) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        session = Object.assign(new EventEmitter(), { query: async () => ({}), release: () => {} });
        return session;
      },
    } as unknown as pg.Pool;
    const fake = scriptedPool({ claim: () => nothingDue() });
    const warn = vi.fn();
    runner(fake.pool, { handle: async () => {} }, { listenerPool, logger: { warn } }).start();
    await vi.advanceTimersByTimeAsync(20_000);
    const unavailable = () => warn.mock.calls.filter(call => call[0] === "[jobs] notifications unavailable; polling remains enabled").length;
    expect(unavailable()).toBe(1);
    available = true;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(session).toBeDefined();
    available = false;
    session!.emit("error", new Error("connection lost"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(unavailable()).toBe(2);
  });

  it("requires leases long enough for an extension to wait for a pooled connection", () => {
    const fake = scriptedPool({});
    expect(() => runner(fake.pool, { leaseMs: 29_999, handle: async () => {} })).toThrow("job_handler_invalid");
    expect(() => runner(fake.pool, { leaseMs: 30_000, handle: async () => {} })).not.toThrow();
  });
});
