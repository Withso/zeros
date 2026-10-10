import { EventEmitter } from "node:events";
import { AsyncResource } from "node:async_hooks";
import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { withSystemTx } from "./db.js";
import * as timing from "./request-timing.js";

const result = (command: string, rowCount: number | null = null) => ({ command, rowCount, rows: [], fields: [] });
const defer = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

function database(work: (sql: unknown, values?: unknown) => unknown = () => result("SELECT", 1)) {
  const query = vi.fn(function (sql: unknown, values?: unknown): unknown {
    if (typeof sql === "string" && sql.startsWith("BEGIN")) return Promise.resolve([result("BEGIN"), result("SET"), result("SELECT", 1)]);
    if (sql === "COMMIT" || sql === "ROLLBACK") return Promise.resolve(result(sql));
    return work(sql, values);
  });
  const client = Object.assign(new EventEmitter(), { query, release: vi.fn() });
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
  return { pool, client, query };
}

function appWithCosts(observer?: (summary: unknown) => void | Promise<void>, databasePool?: pg.Pool) {
  const summaries: unknown[] = [];
  const middleware = timing.requestTiming({ slowMs: Number.POSITIVE_INFINITY,
    costObserver: observer ?? (summary => { summaries.push(summary); }), ...(databasePool ? { databasePool } : {}) });
  const app = new Hono();
  app.use("*", middleware);
  return { app, middleware, summaries };
}

// vi.fn observes returned promises itself; use the real query call shape for
// getter/return-identity controls rather than attributing mock behavior to pg.
function returningNative(native: Promise<unknown>) {
  const db = database();
  Object.defineProperty(db.client, "query", { configurable: true, writable: true,
    value: function (this: unknown, ...args: unknown[]) {
      if (args[0] === "INSERT INTO t VALUES (1)") return native;
      return Reflect.apply(db.query, this, args);
    } });
  return db;
}

describe("opt-in request database cost observation", () => {
  it("counts real completed command tags and scalar persistence annotations without another query", async () => {
    const { pool, client, query } = database(async () => result("INSERT", 2));
    const { app, summaries } = appWithCosts();
    app.post("/cost/:command", async c => {
      await withSystemTx(pool, async tx => {
        const written = await tx.query("INSERT INTO observation_test VALUES ($1)", ["private-parameter"]);
        timing.recordDatabasePersistenceCost(written, { affectedRows: 2, encodedPersistedBytes: 128 });
      });
      return c.json({}, 201);
    });
    expect((await app.request("/cost/private-id?token=private-query", { method: "POST" })).status).toBe(201);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ version: 1, scope: "application-query-port", method: "POST", route: "/cost/:command", status: 201,
      queriesStarted: 3, queriesCompleted: 3, queriesFailed: 0, queriesInFlight: 0,
      transactions: 1, commits: 1, rollbacks: 0, sqlStatements: 5, sqlWriteStatements: 1,
      affectedRows: 2, encodedPersistedBytes: 128, committedEncodedPersistedBytes: 128, complete: true });
    expect(JSON.stringify(summaries)).not.toMatch(/private|INSERT|observation_test/);
    expect(query).toHaveBeenCalledTimes(3);
    expect(client.query).toBe(query);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not wrap queries or touch annotation objects when disabled or outside a request", async () => {
    const { pool, client, query } = database(async () => result("INSERT", 1));
    const annotation = Object.defineProperty({}, "affectedRows", { get() { throw new Error("must not inspect"); } });
    const app = new Hono();
    app.use("*", timing.requestTiming({ slowMs: Number.POSITIVE_INFINITY }));
    app.get("/cost", async c => {
      await withSystemTx(pool, async tx => {
        expect(tx.query).toBe(query);
        timing.recordDatabasePersistenceCost(await tx.query("INSERT INTO t VALUES (1)"), annotation as never);
      });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(() => timing.recordDatabasePersistenceCost({}, annotation as never)).not.toThrow();
    expect(client.query).toBe(query);
  });

  it("leaves unannotated rows and persisted bytes unavailable instead of inferring them from parameters", async () => {
    const values = Object.defineProperty({}, "toJSON", { get() { throw new Error("must not coerce parameters"); } });
    const { pool } = database(async () => result("INSERT", 9));
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await withSystemTx(pool, async tx => { await tx.query("INSERT INTO t VALUES ($1)", [values]); });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ sqlWriteStatements: 1, observedAffectedRows: 9,
      affectedRows: null, encodedPersistedBytes: null, committedEncodedPersistedBytes: null, complete: false });
  });

  it("recognizes a writable CTE despite its SELECT completion and reconciles row counts exactly once", async () => {
    const { pool } = database(async () => result("SELECT", 1));
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await withSystemTx(pool, async tx => {
        const written = await tx.query("WITH added AS (INSERT INTO t VALUES (1) RETURNING *), pruned AS (DELETE FROM t WHERE false RETURNING *) SELECT count(*) FROM added");
        timing.recordDatabasePersistenceCost(written, { writeStatements: 1, affectedRows: 5, encodedPersistedBytes: 64 });
        timing.recordDatabasePersistenceCost(written, { writeStatements: 1, affectedRows: 5, encodedPersistedBytes: 64 });
      });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ sqlWriteStatements: 1, affectedRows: 5, encodedPersistedBytes: 64,
      committedEncodedPersistedBytes: 64, complete: true });
  });

  it.each(["FOR UPDATE", "FOR NO KEY UPDATE", "FOR SHARE", "FOR KEY SHARE"])("does not treat quoted text, comments or %s as persisted writes", async locking => {
    const { pool } = database(async () => result("SELECT", 1));
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await withSystemTx(pool, async tx => { await tx.query(`SELECT 'INSERT; DELETE', $$ UPDATE $$, 1 /* DELETE; */ FROM t ${locking} -- INSERT\n`); });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ sqlWriteStatements: 0, affectedRows: 0, encodedPersistedBytes: 0, complete: true });
  });

  it("reports function and opaque query coverage as unavailable without reading arbitrary text getters", async () => {
    const config = Object.defineProperty({}, "text", { get() { throw new Error("observer must not inspect config"); } });
    const { pool } = database(async () => result("SELECT", 1));
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await withSystemTx(pool, async tx => { await tx.query(config as pg.QueryConfig); });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ sqlWriteStatements: null, affectedRows: null, encodedPersistedBytes: null, complete: false });
  });

  it("does not infer that a SELECT calling a function has no persistence side effects", async () => {
    const { pool } = database(async () => result("SELECT", 1));
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await withSystemTx(pool, async tx => { await tx.query("SELECT future_mutating_function()"); });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ sqlWriteStatements: null, affectedRows: null, encodedPersistedBytes: null, complete: false });
  });

  it("requires the exact helper setup before treating a setup-looking function as known nonpersistent work", async () => {
    const { pool } = database(async () => result("SELECT", 1));
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await withSystemTx(pool, async tx => { await tx.query("SELECT set_config('unrelated_setting', 'fixture_value', true)"); });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ sqlWriteStatements: null, affectedRows: null, encodedPersistedBytes: null, complete: false });
  });

  it("separates completed write work from committed payload bytes on rollback", async () => {
    const original = new Error("original work failure");
    const { pool } = database(async () => result("UPDATE", 3));
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await expect(withSystemTx(pool, async tx => {
        timing.recordDatabasePersistenceCost(await tx.query("UPDATE t SET value=1"), { affectedRows: 3, encodedPersistedBytes: 96 });
        throw original;
      })).rejects.toBe(original);
      return c.text("handled");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ transactions: 1, commits: 0, rollbacks: 1,
      sqlWriteStatements: 1, affectedRows: 3, encodedPersistedBytes: 96, committedEncodedPersistedBytes: 0, complete: true });
  });

  it("counts multi-result statements without double counting result-bound annotations", async () => {
    const { pool } = database(async () => [result("UPDATE", 2), result("DELETE", 3)]);
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await withSystemTx(pool, async tx => {
        const results = await tx.query("UPDATE t SET value=1; DELETE FROM t WHERE false") as unknown as pg.QueryResult[];
        timing.recordDatabasePersistenceCost(results[0]!, { affectedRows: 2, encodedPersistedBytes: 20 });
        timing.recordDatabasePersistenceCost(results[1]!, { affectedRows: 3, encodedPersistedBytes: 30 });
      });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ queriesCompleted: 3, sqlStatements: 6, sqlWriteStatements: 2,
      affectedRows: 5, encodedPersistedBytes: 50, committedEncodedPersistedBytes: 50, complete: true });
  });

  it("keeps concurrent requests and checked-out clients isolated and restores before release", async () => {
    const { app, summaries } = appWithCosts();
    const clients: ReturnType<typeof database>[] = [];
    app.get("/cost/:count", async c => {
      const count = Number(c.req.param("count"));
      const db = database(async () => { await new Promise(done => setTimeout(done, 2)); return result("INSERT", count); });
      clients.push(db);
      db.client.release.mockImplementation(() => { expect(db.client.query).toBe(db.query); });
      await withSystemTx(db.pool, async tx => {
        timing.recordDatabasePersistenceCost(await tx.query("INSERT INTO t VALUES (1)"), { affectedRows: count, encodedPersistedBytes: count * 10 });
      });
      return c.text("ok");
    });
    const replies = await Promise.all([app.request("/cost/2"), app.request("/cost/5")]);
    expect(replies.map(reply => reply.status)).toEqual([200, 200]);
    expect(summaries).toHaveLength(2);
    expect(summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ affectedRows: 2, encodedPersistedBytes: 20, transactions: 1 }),
      expect.objectContaining({ affectedRows: 5, encodedPersistedBytes: 50, transactions: 1 }),
    ]));
    expect(clients.every(db => db.client.query === db.query)).toBe(true);
  });

  it("preserves the returned Promise and never reads its overridden then getter", async () => {
    const native = Promise.resolve(result("INSERT", 1));
    Object.defineProperty(native, "then", { get() { throw new Error("do not read then getter"); } });
    const { pool } = returningNative(native);
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await withSystemTx(pool, async tx => {
        const returned = tx.query("INSERT INTO t VALUES (1)");
        expect(returned).toBe(native);
        timing.recordDatabasePersistenceCost(await returned, { affectedRows: 1, encodedPersistedBytes: 8 });
      });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ affectedRows: 1, complete: true });
  });

  it("preserves explicit pg callback receiver, arguments, exactly-once delivery and returned object", async () => {
    const receiver = {};
    const returned = Object.defineProperty({}, "then", { get() { throw new Error("do not read thenable getter"); } });
    const inserted = result("INSERT", 1);
    const { pool, client, query } = database();
    const original = client.query;
    const callback = vi.fn();
    client.query = vi.fn(function (sql: unknown, ...args: unknown[]) {
      if (sql !== "INSERT INTO t VALUES (1)") return original(sql, args[0]);
      const done = args.at(-1) as (this: unknown, error: unknown, value: unknown) => void;
      queueMicrotask(() => done.call(receiver, null, inserted));
      return returned;
    });
    const owningQuery = client.query;
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await withSystemTx(pool, async tx => {
        await new Promise<void>((resolve, reject) => {
          const actual = tx.query("INSERT INTO t VALUES (1)", [], function (this: unknown, error, value) {
            callback(this, error, value);
            if (error) { reject(error); return; }
            timing.recordDatabasePersistenceCost(value, { affectedRows: 1, encodedPersistedBytes: 8 });
            resolve();
          });
          expect(actual).toBe(returned);
        });
      });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(callback).toHaveBeenCalledExactlyOnceWith(receiver, null, inserted);
    expect(client.query).toBe(owningQuery);
    expect(query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(summaries[0]).toMatchObject({ affectedRows: 1, sqlWriteStatements: 1, complete: true });
  });

  it("does not invoke a native Promise constructor getter while attaching observation", async () => {
    const native = Promise.resolve(result("INSERT", 1));
    const getter = vi.fn(() => { throw new Error("do not inspect promise constructor"); });
    Object.defineProperty(native, "constructor", { configurable: true, get: getter });
    const { pool } = returningNative(native);
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await withSystemTx(pool, async tx => {
        const returned = tx.query("INSERT INTO t VALUES (1)");
        expect(returned).toBe(native);
        expect(getter).not.toHaveBeenCalled();
        Reflect.deleteProperty(native, "constructor");
        await returned;
      });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ complete: false });
  });

  it("binds a reused pg socket callback result to its submitting request outside that async scope", async () => {
    const socket = new AsyncResource("fixture-pg-socket");
    const receiver = {}, inserted = result("INSERT", 1);
    const { pool, client, query } = database();
    Object.defineProperty(client, "query", { configurable: true, writable: true,
      value: function (this: unknown, ...args: unknown[]) {
        if (args[0] !== "INSERT INTO t VALUES (1)") return Reflect.apply(query, this, args);
        const callback = args.at(-1) as (...values: unknown[]) => void;
        queueMicrotask(() => socket.runInAsyncScope(callback, receiver, null, inserted));
      } });
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await withSystemTx(pool, tx => new Promise<void>((resolve, reject) => {
        tx.query("INSERT INTO t VALUES (1)", function (this: unknown, error, value) {
          expect(this).toBe(receiver);
          if (error) { reject(error); return; }
          timing.recordDatabasePersistenceCost(value, { affectedRows: 1, encodedPersistedBytes: 8 });
          resolve();
        });
      }));
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ affectedRows: 1, encodedPersistedBytes: 8, complete: true });
    socket.emitDestroy();
  });

  it("keeps partial multi-statement failure unavailable and never retries the original error", async () => {
    const original = new Error("original database failure");
    const { pool, query } = database(async () => { throw original; });
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await expect(withSystemTx(pool, async tx => { await tx.query("INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)"); })).rejects.toBe(original);
      return c.text("handled");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(query).toHaveBeenCalledTimes(3);
    expect(summaries[0]).toMatchObject({ queriesFailed: 1, rollbacks: 1, sqlStatements: null,
      sqlWriteStatements: null, affectedRows: null, encodedPersistedBytes: null, complete: false });
  });

  it("does not turn observer exceptions or rejected promises into request/transaction failures", async () => {
    const failure = new Error("private observer failure");
    for (const observer of [() => { throw failure; }, async () => { throw failure; }]) {
      const { app, middleware } = appWithCosts(observer);
      const { pool, query } = database();
      app.get("/cost", async c => { await withSystemTx(pool, async () => undefined); return c.text("ok"); });
      expect((await app.request("/cost")).status).toBe(200);
      await Promise.resolve();
      expect(query).not.toHaveBeenCalledWith("ROLLBACK");
      expect(middleware.costObserverStatus()).toMatchObject({ errors: 1 });
    }
  });

  it("bounds asynchronous observer retention and reports drops without delaying responses", async () => {
    const blocked = defer<void>();
    const observer = vi.fn(() => blocked.promise);
    const { app, middleware } = appWithCosts(observer);
    app.get("/cost", c => c.text("ok"));
    for (let i = 0; i < 20; i++) expect((await app.request("/cost")).status).toBe(200);
    expect(observer).toHaveBeenCalledTimes(16);
    expect(middleware.costObserverStatus()).toEqual({ enabled: true, pending: 16, dropped: 4, errors: 0 });
    blocked.resolve();
    await Promise.resolve();
    expect(middleware.costObserverStatus()).toMatchObject({ pending: 0 });
  });

  it("freezes incomplete evidence when a query outlives the request", async () => {
    const entered = defer<void>();
    const pending = defer<ReturnType<typeof result>>();
    const { pool, client, query } = database(() => { entered.resolve(); return pending.promise; });
    const { app, summaries } = appWithCosts();
    let detached!: Promise<void>;
    app.get("/cost", async c => {
      detached = withSystemTx(pool, async tx => {
        timing.recordDatabasePersistenceCost(await tx.query("INSERT INTO t VALUES (1)"), { affectedRows: 1, encodedPersistedBytes: 8 });
      });
      await entered.promise;
      return c.text("stream started");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ queriesStarted: 2, queriesCompleted: 1, queriesInFlight: 1,
      sqlStatements: null, sqlWriteStatements: null, affectedRows: null, encodedPersistedBytes: null, complete: false });
    expect(Object.isFrozen(summaries[0])).toBe(true);
    const before = JSON.stringify(summaries[0]);
    pending.resolve(result("INSERT", 1));
    await detached;
    expect(JSON.stringify(summaries[0])).toBe(before);
    expect(client.query).toBe(query);
  });

  it("restores an inherited query method without introducing a pooled-client own property", async () => {
    const { pool, client, query } = database(async () => result("INSERT", 1));
    delete (client as Partial<typeof client>).query;
    Object.setPrototypeOf(client, Object.assign(Object.create(EventEmitter.prototype), { query }));
    client.release.mockImplementation(() => {
      expect(Object.hasOwn(client, "query")).toBe(false);
      expect(client.query).toBe(query);
    });
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await withSystemTx(pool, async tx => {
        timing.recordDatabasePersistenceCost(await tx.query("INSERT INTO t VALUES (1)"), { affectedRows: 1, encodedPersistedBytes: 8 });
      });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ complete: true });
    expect(Object.hasOwn(client, "query")).toBe(false);
  });

  it("never invokes annotation or completion getters and fails only metric coverage", async () => {
    const commandGetter = vi.fn(() => { throw new Error("must not read completion getter"); });
    const rowsGetter = vi.fn(() => { throw new Error("must not read annotation getter"); });
    const completion = Object.defineProperty({}, "command", { get: commandGetter });
    const annotation = Object.defineProperty({ encodedPersistedBytes: 8 }, "affectedRows", { get: rowsGetter });
    const { pool } = database(async () => completion);
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await withSystemTx(pool, async tx => { timing.recordDatabasePersistenceCost(await tx.query("INSERT INTO t VALUES (1)"), annotation as never); });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(commandGetter).not.toHaveBeenCalled();
    expect(rowsGetter).not.toHaveBeenCalled();
    expect(summaries[0]).toMatchObject({ complete: false });
  });

  it("does not accept changed annotations or count fabricated result objects", async () => {
    const { pool } = database(async () => result("INSERT", 1));
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await withSystemTx(pool, async tx => {
        const written = await tx.query("INSERT INTO t VALUES (1)");
        timing.recordDatabasePersistenceCost(written, { affectedRows: 1, encodedPersistedBytes: 8 });
        timing.recordDatabasePersistenceCost(written, { affectedRows: 2, encodedPersistedBytes: 16 });
        timing.recordDatabasePersistenceCost(result("INSERT", 99), { affectedRows: 99, encodedPersistedBytes: 999 });
      });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ observedAffectedRows: 1, affectedRows: null, encodedPersistedBytes: null, complete: false });
  });

  it("observes direct pool queries and autocommitted bytes while preserving the pool receiver", async () => {
    const raw = vi.fn(function (this: unknown) {
      expect(this).toBe(pool);
      return Promise.resolve(result("INSERT", 3));
    });
    const pool = { query: raw } as unknown as pg.Pool;
    const { app, summaries } = appWithCosts(undefined, pool);
    app.get("/cost", async c => {
      timing.recordDatabasePersistenceCost(await pool.query("INSERT INTO t VALUES (1)"), { affectedRows: 3, encodedPersistedBytes: 12 });
      return c.text("ok");
    });
    expect(pool.query).toBe(raw);
    expect((await app.request("/cost")).status).toBe(200);
    expect(pool.query).toBe(raw);
    expect(raw).toHaveBeenCalledOnce();
    expect(summaries[0]).toMatchObject({ queriesStarted: 1, queriesCompleted: 1, transactions: 0, commits: 0,
      sqlStatements: 1, sqlWriteStatements: 1, affectedRows: 3, encodedPersistedBytes: 12, committedEncodedPersistedBytes: 12, complete: true });
  });

  it("keeps overlapping raw-pool request scopes isolated and restores only after the final request", async () => {
    const first = defer<ReturnType<typeof result>>(), second = defer<ReturnType<typeof result>>();
    const entered = defer<void>();
    const raw = vi.fn((_sql: unknown, values?: unknown[]) => { entered.resolve(); return values?.[0] === 1 ? first.promise : second.promise; });
    const pool = { query: raw } as unknown as pg.Pool;
    const { app, summaries } = appWithCosts(undefined, pool);
    app.get("/cost/:n", async c => {
      const n = Number(c.req.param("n"));
      timing.recordDatabasePersistenceCost(await pool.query("INSERT INTO t VALUES ($1)", [n]), { affectedRows: n, encodedPersistedBytes: n * 8 });
      return c.text("ok");
    });
    const a = app.request("/cost/1");
    await entered.promise;
    const b = app.request("/cost/2");
    first.resolve(result("INSERT", 1));
    expect((await a).status).toBe(200);
    expect(pool.query).not.toBe(raw);
    second.resolve(result("INSERT", 2));
    expect((await b).status).toBe(200);
    expect(pool.query).toBe(raw);
    expect(summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ queriesStarted: 1, affectedRows: 1, encodedPersistedBytes: 8, complete: true }),
      expect.objectContaining({ queriesStarted: 1, affectedRows: 2, encodedPersistedBytes: 16, complete: true }),
    ]));
  });

  it("leaves direct pool query identity untouched with observation disabled", async () => {
    const raw = vi.fn(async () => result("SELECT", 1));
    const pool = { query: raw } as unknown as pg.Pool;
    const app = new Hono();
    app.use("*", timing.requestTiming({ slowMs: Number.POSITIVE_INFINITY, databasePool: pool }));
    app.get("/cost", async c => { expect(pool.query).toBe(raw); await pool.query("SELECT 1"); return c.text("ok"); });
    expect((await app.request("/cost")).status).toBe(200);
    expect(pool.query).toBe(raw);
  });

  it("counts pool.query delegating to its internal client exactly once", async () => {
    const clientQuery = vi.fn(async (_sql: string) => result("INSERT", 1));
    const client = { query: clientQuery };
    const raw = function (sql: string) { return client.query(sql); };
    const pool = { query: raw } as unknown as pg.Pool;
    const { app, summaries } = appWithCosts(undefined, pool);
    app.get("/cost", async c => {
      timing.recordDatabasePersistenceCost(await pool.query("INSERT INTO t VALUES (1)"), { affectedRows: 1, encodedPersistedBytes: 8 });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(clientQuery).toHaveBeenCalledOnce();
    expect(client.query).toBe(clientQuery);
    expect(pool.query).toBe(raw);
    expect(summaries[0]).toMatchObject({ queriesStarted: 1, queriesCompleted: 1, sqlStatements: 1, sqlWriteStatements: 1, complete: true });
  });

  it("does not attribute overlapping unobserved requests sharing a pool to the observed request", async () => {
    const entered = defer<void>(), blocked = defer<ReturnType<typeof result>>();
    const raw = vi.fn((_sql: unknown, values?: unknown[]) => {
      if (values?.[0] === 1) { entered.resolve(); return blocked.promise; }
      return Promise.resolve(result("INSERT", 5));
    });
    const pool = { query: raw } as unknown as pg.Pool;
    const { app, summaries } = appWithCosts(undefined, pool);
    app.get("/cost", async c => {
      timing.recordDatabasePersistenceCost(await pool.query("INSERT INTO t VALUES ($1)", [1]), { affectedRows: 1, encodedPersistedBytes: 8 });
      return c.text("observed");
    });
    const unobserved = new Hono();
    unobserved.use("*", timing.requestTiming({ slowMs: Number.POSITIVE_INFINITY, databasePool: pool }));
    unobserved.get("/cost", async c => { await pool.query("INSERT INTO t VALUES ($1)", [5]); return c.text("unobserved"); });
    const request = app.request("/cost");
    await entered.promise;
    expect((await unobserved.request("/cost")).status).toBe(200);
    expect(summaries).toHaveLength(0);
    blocked.resolve(result("INSERT", 1));
    expect((await request).status).toBe(200);
    expect(pool.query).toBe(raw);
    expect(raw).toHaveBeenCalledTimes(2);
    expect(summaries[0]).toMatchObject({ queriesStarted: 1, observedAffectedRows: 1, affectedRows: 1, encodedPersistedBytes: 8, complete: true });
  });
});

describe("cost observation coverage and annotation consistency", () => {
  it.each(["immutable", "accessor"])("propagates failed %s connect observation to every concurrent pool borrower", async kind => {
    const entered = defer<void>(), finish = defer<void>();
    const raw = database(async () => result("INSERT", 5));
    const connect = async () => raw.client;
    const getter = vi.fn(() => connect);
    const pool = { query: async () => result("SELECT", 1) } as unknown as pg.Pool;
    Object.defineProperty(pool, "connect", kind === "immutable" ? { value: connect, configurable: false, writable: false } :
      { get: getter, configurable: true });
    const { app, summaries } = appWithCosts(undefined, pool);
    app.get("/cost/:n", async c => {
      if (c.req.param("n") === "1") { entered.resolve(); await finish.promise; }
      const client = await pool.connect();
      await client.query("INSERT INTO t SELECT 1");
      client.release();
      return c.text("ok");
    });
    const first = app.request("/cost/1");
    await entered.promise;
    expect((await app.request("/cost/2")).status).toBe(200);
    finish.resolve();
    expect((await first).status).toBe(200);
    expect(summaries).toHaveLength(2);
    expect(summaries.every(value => (value as timing.RequestDatabaseCost).complete === false)).toBe(true);
    expect(pool.connect).toBe(connect);
    if (kind === "accessor") expect(getter).toHaveBeenCalledTimes(3); // Two actual calls plus the assertion above, never observation.
  });

  it.each(["pool", "helper"])("attributes a %s query callback's unchecked descendants outside active ALS to its submitting cost scope", async port => {
    const socket = new AsyncResource("fixture-existing-query-socket");
    const owned = database(), unchecked = database(async () => result("INSERT", 5));
    const receiver = {}, returned = {};
    const query = function (this: unknown, ...args: unknown[]) {
      if (args[0] !== "SELECT 1") return Reflect.apply(owned.query, this, args);
      const callback = args.at(-1) as (...values: unknown[]) => void;
      queueMicrotask(() => socket.runInAsyncScope(callback, receiver, null, result("SELECT", 1)));
      return returned;
    };
    Object.defineProperty(owned.client, "query", { configurable: true, writable: true, value: query });
    const connect = vi.fn().mockResolvedValueOnce(port === "helper" ? owned.client : unchecked.client).mockResolvedValue(unchecked.client);
    const pool = { connect, query } as unknown as pg.Pool;
    const { app, summaries } = appWithCosts(undefined, pool);
    const work = (tx: pg.Pool | pg.PoolClient) => new Promise<void>((resolve, reject) => {
      const actual = tx.query("SELECT 1", function (this: unknown, error) {
        expect(this).toBe(receiver);
        if (error) { reject(error); return; }
        void pool.connect().then(async client => {
          try { await client.query("INSERT INTO t SELECT 1"); } finally { client.release(); }
        }).then(resolve, reject);
      });
      expect(actual).toBe(returned);
    });
    app.get("/cost", async c => { if (port === "helper") await withSystemTx(pool, work); else await work(pool); return c.text("ok"); });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ uncheckedClientCheckouts: 1, complete: false, sqlStatements: null });
    expect(pool.connect).toBe(connect);
  });

  it("does not charge a query callback's descendants to another live request's async resource", async () => {
    const entered = defer<void>(), callbackComplete = defer<void>(), releaseOther = defer<void>();
    const borrowed = database(async () => result("INSERT", 5));
    let callback!: (...args: unknown[]) => void;
    const query = (_sql: unknown, done: (...args: unknown[]) => void) => { callback = done; entered.resolve(); };
    const pool = { query, connect: async () => borrowed.client } as unknown as pg.Pool;
    const { app, summaries } = appWithCosts(undefined, pool);
    app.get("/cost/:n", async c => {
      if (c.req.param("n") === "other") {
        const socket = new AsyncResource("fixture-other-live-request");
        socket.runInAsyncScope(callback, null, null, result("SELECT", 1));
        await callbackComplete.promise;
        await releaseOther.promise;
      } else await new Promise<void>((resolve, reject) => {
        pool.query("SELECT 1", error => {
          if (error) { reject(error); return; }
          void pool.connect().then(async client => {
            try { await client.query("INSERT INTO t SELECT 1"); } finally { client.release(); }
          }).then(() => { callbackComplete.resolve(); resolve(); }, reject);
        });
      });
      return c.text("ok");
    });
    const owner = app.request("/cost/owner");
    await entered.promise;
    const other = app.request("/cost/other");
    expect((await owner).status).toBe(200);
    expect(summaries[0]).toMatchObject({ uncheckedClientCheckouts: 1, complete: false });
    releaseOther.resolve();
    expect((await other).status).toBe(200);
    expect(summaries[1]).toMatchObject({ uncheckedClientCheckouts: 0, queriesStarted: 0, complete: true });
  });

  it("leaves connect and client query identities intact when observation is disabled", async () => {
    const { pool, client, query } = database(async () => result("INSERT", 1));
    const originalConnect = pool.connect;
    Object.defineProperty(pool, "query", { configurable: true, writable: true, value: async () => result("SELECT", 1) });
    const originalQuery = pool.query;
    const app = new Hono();
    app.use("*", timing.requestTiming({ slowMs: Number.POSITIVE_INFINITY, databasePool: pool }));
    app.get("/cost", async c => {
      expect(pool.connect).toBe(originalConnect);
      expect(pool.query).toBe(originalQuery);
      const borrowed = await pool.connect();
      expect(borrowed.query).toBe(query);
      await borrowed.query("INSERT INTO t VALUES (1)");
      borrowed.release();
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(pool.connect).toBe(originalConnect);
    expect(client.query).toBe(query);
  });

  it("freezes incomplete checkout coverage when acquisition outlives the request", async () => {
    const entered = defer<void>(), pending = defer<pg.PoolClient>();
    const { client } = database();
    const rawConnect = function () { entered.resolve(); return pending.promise; };
    const pool = { connect: rawConnect, query: async () => result("SELECT", 1) } as unknown as pg.Pool;
    const { app, summaries } = appWithCosts(undefined, pool);
    let detached!: Promise<pg.PoolClient>;
    app.get("/cost", async c => { detached = pool.connect(); await entered.promise; return c.text("started"); });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ uncheckedClientCheckouts: 1, checkoutsInFlight: 1, complete: false, sqlStatements: null });
    const before = JSON.stringify(summaries[0]);
    pending.resolve(client as unknown as pg.PoolClient);
    (await detached).release();
    expect(JSON.stringify(summaries[0])).toBe(before);
    expect(pool.connect).toBe(rawConnect);
  });

  it("never lets a helper acknowledge a different unchecked checkout in the same request", async () => {
    const owned = database(async () => result("INSERT", 1));
    const raw = database(async () => result("INSERT", 8));
    const pool = { connect: vi.fn().mockResolvedValueOnce(raw.client).mockResolvedValue(owned.client),
      query: async () => result("SELECT", 1) } as unknown as pg.Pool;
    const { app, summaries } = appWithCosts(undefined, pool);
    app.get("/cost", async c => {
      const unchecked = await pool.connect();
      await unchecked.query("INSERT INTO t SELECT 1");
      unchecked.release();
      await withSystemTx(pool, async tx => {
        timing.recordDatabasePersistenceCost(await tx.query("INSERT INTO t VALUES (1)"), { affectedRows: 1, encodedPersistedBytes: 8 });
      });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ uncheckedClientCheckouts: 1, checkoutsInFlight: 0, complete: false, sqlStatements: null });
  });

  it("does not exempt an unrelated checkout while an internal pool.query checkout is pending", async () => {
    const entered = defer<void>(), pending = defer<ReturnType<typeof result>>();
    const internal = database(() => { entered.resolve(); return pending.promise; });
    const unrelated = database(async () => result("INSERT", 8));
    const rawConnect = vi.fn().mockResolvedValueOnce(internal.client).mockResolvedValue(unrelated.client);
    const pool = { connect: rawConnect, query: function (sql: string) {
      return pool.connect().then(async client => { try { return await client.query(sql); } finally { client.release(); } });
    } } as unknown as pg.Pool;
    const { app, summaries } = appWithCosts(undefined, pool);
    app.get("/cost", async c => {
      const observed = pool.query("INSERT INTO t VALUES (1)");
      await entered.promise;
      const unchecked = await pool.connect();
      await unchecked.query("INSERT INTO t SELECT 1");
      unchecked.release();
      pending.resolve(result("INSERT", 1));
      timing.recordDatabasePersistenceCost(await observed, { affectedRows: 1, encodedPersistedBytes: 8 });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(rawConnect).toHaveBeenCalledTimes(2);
    expect(pool.connect).toBe(rawConnect);
    expect(summaries[0]).toMatchObject({ uncheckedClientCheckouts: 1, queriesCompleted: 1, complete: false, sqlStatements: null });
  });

  it.each(["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT fixture", "RELEASE SAVEPOINT fixture"])(
    "leaves unowned raw-pool transaction coverage unavailable: %s", async sql => {
      const rawQuery = async () => result(sql.split(" ")[0]!);
      const pool = { query: rawQuery } as unknown as pg.Pool;
      const { app, summaries } = appWithCosts(undefined, pool);
      app.get("/cost", async c => { await pool.query(sql); return c.text("ok"); });
      expect((await app.request("/cost")).status).toBe(200);
      expect(summaries[0]).toMatchObject({ complete: false, sqlWriteStatements: null,
        encodedPersistedBytes: null, committedEncodedPersistedBytes: null });
    });

  it("reports an unchecked direct pool checkout as unavailable rather than certified zero SQL", async () => {
    const { pool, client, query } = database(async () => result("INSERT", 5));
    const rawConnect = pool.connect;
    Object.defineProperty(pool, "query", { configurable: true, writable: true, value: async () => result("SELECT", 1) });
    const { app, summaries } = appWithCosts(undefined, pool);
    app.get("/cost", async c => {
      const borrowed = await pool.connect();
      expect(borrowed.query).toBe(query);
      await borrowed.query("INSERT INTO t VALUES (1)");
      borrowed.release();
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.connect).toBe(rawConnect);
    expect(summaries[0]).toMatchObject({ complete: false, sqlStatements: null, sqlWriteStatements: null,
      affectedRows: null, encodedPersistedBytes: null });
  });

  it("preserves callback checkout receiver, arguments and return identity while refusing unchecked coverage", async () => {
    const { pool, client } = database(async () => result("INSERT", 1));
    const receiver = {}, returned = {}, socket = new AsyncResource("fixture-pool-connect");
    const rawConnect = function (this: unknown, callback: (...args: unknown[]) => void) {
      expect(this).toBe(pool);
      queueMicrotask(() => socket.runInAsyncScope(callback, receiver, null, client, client.release));
      return returned;
    };
    Object.defineProperty(pool, "connect", { configurable: true, writable: true, value: rawConnect });
    Object.defineProperty(pool, "query", { configurable: true, writable: true, value: async () => result("SELECT", 1) });
    const callback = vi.fn();
    const { app, summaries } = appWithCosts(undefined, pool);
    app.get("/cost", async c => {
      await new Promise<void>((resolve, reject) => {
        const actual = pool.connect(function (this: unknown, error, borrowed, release) {
          callback(this, error, borrowed, release);
          if (error || !borrowed) { reject(error ?? new Error("fixture_missing_client")); return; }
          void borrowed.query("INSERT INTO t VALUES (1)").then(() => { release(); resolve(); }, reject);
        });
        expect(actual).toBe(returned);
      });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(callback).toHaveBeenCalledExactlyOnceWith(receiver, null, client, client.release);
    expect(pool.connect).toBe(rawConnect);
    expect(summaries[0]).toMatchObject({ complete: false, sqlStatements: null, sqlWriteStatements: null });
  });

  it("does not accept producer affected rows below a known INSERT completion", async () => {
    const { pool } = database(async () => result("INSERT", 5));
    const { app, summaries } = appWithCosts();
    app.get("/cost", async c => {
      await withSystemTx(pool, async tx => {
        timing.recordDatabasePersistenceCost(await tx.query("INSERT INTO t SELECT 1"), { affectedRows: 0, encodedPersistedBytes: 0 });
      });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ observedAffectedRows: 5, complete: false, affectedRows: null, encodedPersistedBytes: null });
  });

  it.each([{ affectedRows: 5, encodedPersistedBytes: 40 }, { affectedRows: 0, encodedPersistedBytes: 8 }])(
    "refuses positive persistence paired with a zero-write annotation: %j", async annotation => {
      const { pool } = database(async () => result("SELECT", 5));
      const { app, summaries } = appWithCosts();
      app.get("/cost", async c => {
        await withSystemTx(pool, async tx => {
          timing.recordDatabasePersistenceCost(await tx.query("SELECT fixture_mutating_function()"), { writeStatements: 0, ...annotation });
        });
        return c.text("ok");
      });
      expect((await app.request("/cost")).status).toBe(200);
      expect(summaries[0]).toMatchObject({ complete: false, sqlWriteStatements: null, affectedRows: null, encodedPersistedBytes: null });
    });

  it("keeps helper checkouts fully observed when pool checkout observation is enabled", async () => {
    const { pool } = database(async () => result("INSERT", 1));
    Object.defineProperty(pool, "query", { configurable: true, writable: true, value: async () => result("SELECT", 1) });
    const { app, summaries } = appWithCosts(undefined, pool);
    app.get("/cost", async c => {
      await withSystemTx(pool, async tx => {
        timing.recordDatabasePersistenceCost(await tx.query("INSERT INTO t VALUES (1)"), { affectedRows: 1, encodedPersistedBytes: 8 });
      });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(summaries[0]).toMatchObject({ complete: true, queriesStarted: 3, affectedRows: 1, encodedPersistedBytes: 8 });
  });

  it("counts the real pool.query checkout chain only once", async () => {
    const { pool, client, query } = database(async () => result("INSERT", 1));
    const rawConnect = pool.connect;
    const rawQuery = function (this: unknown, sql: string) {
      expect(this).toBe(pool);
      return pool.connect().then(async borrowed => {
        try { return await borrowed.query(sql); } finally { borrowed.release(); }
      });
    };
    Object.defineProperty(pool, "query", { configurable: true, writable: true, value: rawQuery });
    const { app, summaries } = appWithCosts(undefined, pool);
    app.get("/cost", async c => {
      timing.recordDatabasePersistenceCost(await pool.query("INSERT INTO t VALUES (1)"), { affectedRows: 1, encodedPersistedBytes: 8 });
      return c.text("ok");
    });
    expect((await app.request("/cost")).status).toBe(200);
    expect(client.query).toBe(query);
    expect(pool.query).toBe(rawQuery);
    expect(pool.connect).toBe(rawConnect);
    expect(summaries[0]).toMatchObject({ complete: true, queriesStarted: 1, queriesCompleted: 1,
      sqlStatements: 1, sqlWriteStatements: 1, affectedRows: 1, committedEncodedPersistedBytes: 8 });
  });
});
