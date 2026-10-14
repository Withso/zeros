import { EventEmitter } from "node:events";
import { Hono } from "hono";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "./db.js";
import { recordPoolWait, requestTiming } from "./request-timing.js";
import { withWorkOSProviderLocks } from "./workos-provider-locks.js";
import { advisoryLockPurpose, createDatabaseTimingReporter, type RequestDatabaseTiming } from "./database-timing.js";

afterEach(() => vi.restoreAllMocks());

describe("request database spans", () => {
  it("observes fast pool, transaction and lock spans by route without SQL, arguments or raw paths", async () => {
    let clock = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (sql: string) => { if (sql.includes("pg_advisory")) clock += 7; return { rows: [] }; }),
      release: vi.fn(),
    });
    const pool = { connect: async () => { clock += 3; return client; } } as unknown as pg.Pool;
    const original = client.query, observed: unknown[] = [];
    const app = new Hono();
    app.use("*", requestTiming({ slowMs: 60_000, timingObserver: value => { observed.push(value); } }));
    app.post("/v1/items/:item", async c => {
      await withSystemTx(pool, tx => tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,837412)) /*lock_purpose='agent-credential-owner'*/", ["private-owner"]));
      return c.json({}, 201);
    });
    expect((await app.request("/v1/items/private-item?token=private-query", { method: "POST" })).status).toBe(201);
    expect(observed).toEqual([expect.objectContaining({ method: "POST", route: "/v1/items/:item", status: 201,
      droppedSpans: 0, spans: expect.arrayContaining([
        { kind: "pool-wait", offsetMs: 0, durationMs: 3, purpose: null, failed: false },
        { kind: "transaction", offsetMs: 3, durationMs: 7, purpose: null, failed: null },
        { kind: "advisory-lock", offsetMs: 3, durationMs: 7, purpose: "agent-credential-owner", failed: false },
      ]) })]);
    expect(JSON.stringify(observed)).not.toMatch(/private|SELECT|hashtextextended/);
    expect(client.query).toBe(original);
  });

  it("records failed acquires and lock queries without changing their failure or retaining private errors", async () => {
    const error = new Error("private lock detail"), observed: unknown[] = [];
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_advisory")) throw error;
        return { rows: [] };
      }), release: vi.fn(),
    });
    const pool = { connect: async () => client } as unknown as pg.Pool;
    const app = new Hono();
    app.use("*", requestTiming({ slowMs: 60_000, timingObserver: value => { observed.push(value); } }));
    app.get("/v1/busy", async c => {
      recordPoolWait(12);
      await expect(withSystemTx(pool, tx => tx.query("SELECT pg_advisory_xact_lock(1) /*lock_purpose='agent-credential-owner'*/"))).rejects.toBe(error);
      return c.json({}, 503);
    });
    expect((await app.request("/v1/busy")).status).toBe(503);
    expect(observed).toEqual([expect.objectContaining({ spans: expect.arrayContaining([
      expect.objectContaining({ kind: "pool-wait", durationMs: 12, failed: true }),
      expect.objectContaining({ kind: "advisory-lock", purpose: "agent-credential-owner", failed: true }),
    ]) })]);
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(JSON.stringify(observed)).not.toContain("private");
  });

  it("bounds retained spans and ignores late work after the request closes", async () => {
    const observed: unknown[] = [], app = new Hono();
    let late: (() => void) | undefined;
    app.use("*", requestTiming({ slowMs: 60_000, timingObserver: value => { observed.push(value); } }));
    app.get("/v1/many", c => {
      for (let index = 0; index < 70; index++) recordPoolWait(1);
      late = () => recordPoolWait(8);
      return c.text("ok");
    });
    expect((await app.request("/v1/many")).status).toBe(200);
    expect(observed).toEqual([expect.objectContaining({ spans: expect.any(Array), droppedSpans: 6 })]);
    expect((observed[0] as { spans: unknown[] }).spans).toHaveLength(64);
    const before = JSON.stringify(observed);
    late?.();
    expect(JSON.stringify(observed)).toBe(before);
  });

  it("observes WorkOS session-lock acquisition and release without borrowing transaction authority", async () => {
    let clock = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (sql: string) => {
        clock += 4;
        return { rows: [sql.includes("pg_try_advisory_lock") ? { acquired: true } : { unlocked: true }] };
      }), release: vi.fn(),
    });
    const pool = { options: { max: 4 }, connect: async () => { clock += 3; return client; } } as unknown as pg.Pool;
    const original = client.query, observed: RequestDatabaseTiming[] = [], app = new Hono();
    app.use("*", requestTiming({ slowMs: 60_000, timingObserver: value => { observed.push(value); } }));
    app.get("/v1/provider", async c => c.text(await withWorkOSProviderLocks(pool, ["private-provider-key"], async () => "ok")));
    expect((await app.request("/v1/provider")).status).toBe(200);
    expect(observed[0]?.spans.filter(span => span.kind === "advisory-lock")).toEqual([
      { kind: "advisory-lock", offsetMs: 3, durationMs: 4, purpose: "workos-provider", failed: false },
      { kind: "advisory-lock", offsetMs: 7, durationMs: 4, purpose: "workos-provider", failed: false },
    ]);
    expect(observed[0]?.spans).toContainEqual({ kind: "pool-wait", offsetMs: 0, durationMs: 3, purpose: null, failed: false });
    expect(client.query).toBe(original);
    expect(JSON.stringify(observed)).not.toContain("private");
  });

  it("preserves callback query results and concurrent request attribution", async () => {
    const observed: RequestDatabaseTiming[] = [], app = new Hono();
    const create = () => {
      const query = vi.fn((sql: string, callback?: (error: Error | null, value?: unknown) => void) => {
        const result = { rows: [], command: "SELECT", rowCount: 0 };
        if (callback) { queueMicrotask(() => callback(null, result)); return undefined; }
        return Promise.resolve(result);
      });
      const client = Object.assign(new EventEmitter(), { query, release: vi.fn() });
      return { client, query, pool: { connect: async () => client } as unknown as pg.Pool };
    };
    const first = create(), second = create();
    app.use("*", requestTiming({ slowMs: 60_000, timingObserver: value => { observed.push(value); } }));
    app.get("/v1/first", async c => {
      await withSystemTx(first.pool, tx => new Promise<void>((resolve, reject) => {
        tx.query("SELECT pg_advisory_xact_lock(1) /*lock_purpose='auth-identity'*/", (error, result) => {
          if (error) { reject(error); return; }
          expect(result.rows).toEqual([]); resolve();
        });
      }));
      return c.text("ok");
    });
    app.get("/v1/second", async c => {
      await withSystemTx(second.pool, tx => tx.query("SELECT pg_advisory_xact_lock(1) /*lock_purpose='auth-email'*/"));
      return c.text("ok");
    });
    const responses = await Promise.all([app.request("/v1/first"), app.request("/v1/second")]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(observed.map(value => [value.route, value.spans.filter(span => span.kind === "advisory-lock").map(span => span.purpose)]).sort())
      .toEqual([["/v1/first", ["auth-identity"]], ["/v1/second", ["auth-email"]]]);
    expect(first.client.query).toBe(first.query); expect(second.client.query).toBe(second.query);
  });

  it("does not delay or fail a request when the timing observer fails or stops consuming", async () => {
    const app = new Hono(), observer = vi.fn(() => new Promise<void>(() => undefined));
    app.use("*", requestTiming({ slowMs: 60_000, timingObserver: observer }));
    app.get("/v1/fast", c => { recordPoolWait(1); return c.text("ok"); });
    for (let index = 0; index < 20; index++) expect((await app.request("/v1/fast")).status).toBe(200);
    expect(observer).toHaveBeenCalledTimes(16);
    for (const timingObserver of [() => { throw new Error("private observer failure"); }, () => Promise.reject(new Error("private observer failure"))]) {
      const failing = new Hono();
      failing.use("*", requestTiming({ slowMs: 60_000, timingObserver }));
      failing.get("/v1/fast", c => c.text("ok"));
      expect((await failing.request("/v1/fast")).status).toBe(200);
    }
  });
});

describe("database histogram reporting", () => {
  const request = (route = "/v1/items/:id"): RequestDatabaseTiming => ({ version: 1, scope: "transaction-helpers-and-provider-locks",
    method: "GET", route, status: 200, droppedSpans: 0,
    spans: [{ kind: "pool-wait", offsetMs: 0, durationMs: 12, purpose: null, failed: false }] });

  it("reports bounded disjoint buckets once per active window and performs no idle loop", () => {
    vi.useFakeTimers();
    try {
      const log = vi.fn(), reporter = createDatabaseTimingReporter({ log, intervalMs: 1000 });
      vi.advanceTimersByTime(3000);
      expect(log).not.toHaveBeenCalled();
      reporter.observe(request()); reporter.observe(request());
      vi.advanceTimersByTime(999);
      expect(log).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(log).toHaveBeenCalledOnce();
      const report = JSON.parse(log.mock.calls[0]![0].slice("[database] timing ".length));
      expect(report.series).toEqual([expect.objectContaining({ route: "/v1/items/:id", count: 2, sumMs: 24, maxMs: 12 })]);
      expect(report.series[0].buckets.reduce((total: number, count: number) => total + count, 0)).toBe(2);
      expect(report.series[0].buckets[report.bucketUpperBoundsMs.indexOf(20)]).toBe(2);
      vi.advanceTimersByTime(10_000);
      expect(log).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("bounds series cardinality, exposes loss and resets the window even if logging throws", () => {
    const log = vi.fn(), reporter = createDatabaseTimingReporter({ log, maxSeries: 1 });
    reporter.observe(request()); reporter.observe(request("/v1/another"));
    reporter.observe({ ...request(), droppedSpans: 3 });
    reporter.flush();
    const report = JSON.parse(log.mock.calls[0]![0].slice("[database] timing ".length));
    expect(report.series).toHaveLength(1);
    expect(report.droppedSpans).toBe(4);
    log.mockImplementationOnce(() => { throw new Error("private logger failure"); });
    reporter.observe(request());
    expect(() => reporter.flush()).not.toThrow();
    reporter.flush();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("reads only registered static tags and never invokes query or argument getters", () => {
    const getter = vi.fn(() => { throw new Error("private getter"); });
    expect(advisoryLockPurpose({ get text() { return getter(); } })).toBeNull();
    expect(advisoryLockPurpose({ text: "SELECT pg_advisory_xact_lock($1) /*lock_purpose='agent-credential-owner'*/", get values() { return getter(); } }))
      .toBe("agent-credential-owner");
    expect(advisoryLockPurpose("SELECT pg_advisory_xact_lock($1) /*lock_purpose='private-value'*/")).toBeNull();
    expect(advisoryLockPurpose("SELECT pg_advisory_xact_lock($1) /*lock_purpose='agent-credential-owner'*/ /*lock_purpose='agent-credential-owner'*/")).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });
});
