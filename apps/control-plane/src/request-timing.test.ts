import { EventEmitter } from "node:events";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import { withSystemTx } from "./db.js";
import { recordPoolWait, recordTransactionTiming, requestTiming, observeTransactionTiming } from "./request-timing.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function timedApp(slowMs = 0) {
  const log = vi.fn();
  const app = new Hono();
  app.use("*", requestTiming({ slowMs, log }));
  return { app, lines: () => log.mock.calls.map(([line]) => String(line)) };
}

describe("request timing", () => {
  it("logs a slow request by route template with its transaction timing", async () => {
    const { app, lines } = timedApp();
    app.post("/v1/items/:item", (c) => {
      recordTransactionTiming(4, 15);
      recordTransactionTiming(6, 25);
      return c.json({}, 201);
    });
    const response = await app.request("/v1/items/private-id-123?token=secret", { method: "POST" });
    expect(response.status).toBe(201);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/^\[http\] slow POST \/v1\/items\/:item 201 \d+ms tx=2 txMs=30 waitMs=10$/);
    expect(lines()[0]).not.toContain("private-id-123");
    expect(lines()[0]).not.toContain("secret");
  });

  it("does not log requests under the threshold", async () => {
    const { app, lines } = timedApp(60_000);
    app.get("/v1/fast", (c) => c.text("ok"));
    expect((await app.request("/v1/fast")).status).toBe(200);
    expect(lines()).toHaveLength(0);
  });

  it("keeps concurrent requests' database timing separate", async () => {
    const { app, lines } = timedApp();
    app.get("/v1/work/:count", async (c) => {
      for (let i = 0; i < Number(c.req.param("count")); i++) {
        await delay(2);
        recordTransactionTiming(1, 10);
      }
      return c.text("ok");
    });
    await Promise.all([app.request("/v1/work/1"), app.request("/v1/work/3")]);
    expect(lines()).toHaveLength(2);
    expect(lines().some((line) => line.endsWith("tx=1 txMs=9 waitMs=1"))).toBe(true);
    expect(lines().some((line) => line.endsWith("tx=3 txMs=27 waitMs=3"))).toBe(true);
  });

  it("names the catch-all or wildcard route that handled a request, never the raw path", async () => {
    const { app, lines } = timedApp();
    app.all("/v1/github/*", (c) => c.json({}, 503));
    expect((await app.request("/v1/github/private-installation")).status).toBe(503);
    expect((await app.request("/private/path-segment")).status).toBe(404);
    expect(lines()[0]).toMatch(/^\[http\] slow GET \/v1\/github\/\* 503 /);
    expect(lines()[1]).toMatch(/^\[http\] slow GET \/\* 404 /);
    expect(lines().join("\n")).not.toMatch(/private/);
  });

  it("reports a propagated failure without inventing a response status", async () => {
    const { app, lines } = timedApp();
    app.get("/v1/fails", () => {
      throw "not an Error";
    });
    await expect(app.request("/v1/fails")).rejects.toBe("not an Error");
    expect(lines()[0]).toMatch(/^\[http\] slow GET \/v1\/fails error \d+ms /);
  });

  it("does not count work that outlives the logged request", async () => {
    const { app, lines } = timedApp();
    app.get("/v1/stream", (c) => {
      setTimeout(() => {
        recordTransactionTiming(1, 100);
        recordPoolWait(100);
      }, 5);
      return c.text("stream started");
    });
    expect((await app.request("/v1/stream")).status).toBe(200);
    await delay(20);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/ tx=0 txMs=0 waitMs=0$/);
  });

  it("ignores database work outside a request", () => {
    expect(() => {
      recordTransactionTiming(1, 2);
      recordPoolWait(3);
    }).not.toThrow();
  });

  it("attributes shared transaction helpers to the active request", async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const { app, lines } = timedApp();
    app.get("/v1/records", async (c) => {
      await withSystemTx(pool, async () => undefined);
      await withSystemTx(pool, async () => undefined);
      return c.text("ok");
    });
    expect((await app.request("/v1/records")).status).toBe(200);
    expect(lines()[0]).toMatch(/ tx=2 txMs=\d+ waitMs=\d+$/);
  });

  it("records the pool wait of an acquisition that times out", async () => {
    const timeout = Object.assign(new Error("timeout exceeded when trying to connect"), { code: "ETIMEDOUT" });
    const pool = { connect: vi.fn(async () => { await delay(25); throw timeout; }) } as unknown as pg.Pool;
    const { app, lines } = timedApp();
    app.get("/v1/saturated", async (c) => {
      await withSystemTx(pool, async () => undefined).catch(() => undefined);
      return c.json({}, 503);
    });
    expect((await app.request("/v1/saturated")).status).toBe(503);
    const wait = Number(lines()[0]!.match(/ tx=0 txMs=0 waitMs=(\d+)$/)?.[1]);
    expect(wait).toBeGreaterThanOrEqual(20);
  });
});

describe("scoped background transaction timing", () => {
  it("uses the completed helper hook without stealing a surrounding request's accounting", async () => {
    const observed: unknown[] = [];
    const { app, lines } = timedApp();
    app.get("/v1/timing", async c => {
      await observeTransactionTiming(async () => {
        recordTransactionTiming(4, 15);
        recordTransactionTiming(6, 25);
      }, timing => { observed.push(timing); });
      return c.text("ok");
    });
    expect((await app.request("/v1/timing")).status).toBe(200);
    expect(observed).toEqual([{ transactions: 2, waitMs: 10, heldMs: 30 }]);
    expect(lines()[0]).toMatch(/tx=2 txMs=30 waitMs=10$/);
  });

  it("keeps overlapping background scopes separate and refuses detached late samples", async () => {
    let releaseA!: () => void, enteredA!: () => void, late!: () => void;
    const reachedA = new Promise<void>(resolve => { enteredA = resolve; });
    const a: unknown[] = [], b: unknown[] = [];
    const flight = observeTransactionTiming(async () => {
      recordTransactionTiming(1, 10);
      enteredA();
      await new Promise<void>(resolve => { releaseA = resolve; });
      const detached = new Promise<void>(resolve => { late = resolve; });
      void detached.then(() => recordTransactionTiming(99, 999));
    }, value => { a.push(value); });
    await reachedA;
    await observeTransactionTiming(async () => { recordTransactionTiming(2, 20); }, value => { b.push(value); });
    releaseA(); await flight; late(); await Promise.resolve();
    expect(a).toEqual([{ transactions: 1, waitMs: 1, heldMs: 9 }]);
    expect(b).toEqual([{ transactions: 1, waitMs: 2, heldMs: 18 }]);
  });

  it("does not replace either success or failure when its observer throws", async () => {
    const observer = () => { throw new Error("Synthetic timing sink failure"); };
    await expect(observeTransactionTiming(async () => "committed", observer)).resolves.toBe("committed");
    const failure = new Error("Synthetic transaction failure");
    await expect(observeTransactionTiming(async () => { throw failure; }, observer)).rejects.toBe(failure);
  });

  it("keeps nested scopes bounded and excludes a closed child's detached work from its parent", async () => {
    const outer: unknown[] = [], inner: unknown[] = [];
    let release!: () => void, detached!: Promise<void>;
    await observeTransactionTiming(async () => {
      recordTransactionTiming(2, 12);
      await observeTransactionTiming(async () => {
        recordTransactionTiming(3, 23);
        detached = new Promise<void>(resolve => { release = resolve; })
          .then(() => { recordTransactionTiming(99, 999); });
      }, value => { inner.push(value); });
      release(); await detached;
    }, value => { outer.push(value); });
    expect(inner).toEqual([{ transactions: 1, waitMs: 3, heldMs: 20 }]);
    expect(outer).toEqual([{ transactions: 2, waitMs: 5, heldMs: 30 }]);

    const bounded: unknown[] = [];
    await observeTransactionTiming(async () => {
      recordTransactionTiming(NaN, 2);
      recordTransactionTiming(1, Infinity);
      recordTransactionTiming(-10, -1);
      recordPoolWait(100_000_000);
      recordTransactionTiming(0, 100_000_000);
    }, value => { bounded.push(value); });
    expect(bounded).toEqual([{ transactions: 2, waitMs: 86_400_000, heldMs: 86_400_000 }]);
    await expect(observeTransactionTiming(async () => "committed", async () => {
      throw new Error("Synthetic rejected timing sink");
    })).resolves.toBe("committed");
  });

  it("includes a delayed COMMIT only after the existing transaction hook completes, without extra queries", async () => {
    let now = 0, reached!: () => void, release!: () => void;
    const committing = new Promise<void>(resolve => { reached = resolve; });
    const summaries: unknown[] = [];
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (sql: string) => {
        if (sql === "COMMIT") { reached(); await new Promise<void>(resolve => { release = resolve; }); }
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    try {
      const flight = observeTransactionTiming(() => withSystemTx(pool, async tx => {
        now = 7; await tx.query("SELECT 1");
      }), value => { summaries.push(value); });
      await committing;
      expect(summaries).toEqual([]);
      now = 700; release(); await flight;
      expect(summaries).toEqual([{ transactions: 1, waitMs: 0, heldMs: 700 }]);
      expect(client.query).toHaveBeenCalledTimes(3);
      expect(client.release).toHaveBeenCalledOnce();
    } finally { clock.mockRestore(); }
  });

});
