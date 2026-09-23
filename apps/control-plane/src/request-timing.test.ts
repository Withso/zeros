import { EventEmitter } from "node:events";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import { withSystemTx } from "./db.js";
import { recordTransactionTiming, requestTiming } from "./request-timing.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("request timing", () => {
  it("logs a slow request by route template with its transaction timing", async () => {
    const log = vi.fn();
    const app = new Hono();
    app.use("*", requestTiming({ slowMs: 0, log }));
    app.post("/v1/items/:item", (c) => {
      recordTransactionTiming(4, 15);
      recordTransactionTiming(6, 25);
      return c.json({}, 201);
    });
    const response = await app.request("/v1/items/private-id-123?token=secret", { method: "POST" });
    expect(response.status).toBe(201);
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0]![0]);
    expect(line).toMatch(/^\[http\] slow POST \/v1\/items\/:item 201 \d+ms db=2tx\/40ms wait=10ms$/);
    expect(line).not.toContain("private-id-123");
    expect(line).not.toContain("secret");
  });

  it("does not log requests under the threshold", async () => {
    const log = vi.fn();
    const app = new Hono();
    app.use("*", requestTiming({ slowMs: 60_000, log }));
    app.get("/v1/fast", (c) => c.text("ok"));
    expect((await app.request("/v1/fast")).status).toBe(200);
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps concurrent requests' database timing separate", async () => {
    const log = vi.fn();
    const app = new Hono();
    app.use("*", requestTiming({ slowMs: 0, log }));
    app.get("/v1/work/:count", async (c) => {
      for (let i = 0; i < Number(c.req.param("count")); i++) {
        await delay(2);
        recordTransactionTiming(1, 10);
      }
      return c.text("ok");
    });
    await Promise.all([app.request("/v1/work/1"), app.request("/v1/work/3")]);
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.endsWith("db=1tx/10ms wait=1ms"))).toBe(true);
    expect(lines.some((line) => line.endsWith("db=3tx/30ms wait=3ms"))).toBe(true);
  });

  it("labels an unmatched path without echoing it", async () => {
    const log = vi.fn();
    const app = new Hono();
    app.use("*", requestTiming({ slowMs: 0, log }));
    expect((await app.request("/private/path-segment")).status).toBe(404);
    const line = String(log.mock.calls[0]![0]);
    expect(line).toMatch(/^\[http\] slow GET unmatched 404 /);
    expect(line).not.toContain("path-segment");
  });

  it("ignores transactions outside a request", () => {
    expect(() => recordTransactionTiming(1, 2)).not.toThrow();
  });

  it("attributes shared transaction helpers to the active request", async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const log = vi.fn();
    const app = new Hono();
    app.use("*", requestTiming({ slowMs: 0, log }));
    app.get("/v1/records", async (c) => {
      await withSystemTx(pool, async () => undefined);
      await withSystemTx(pool, async () => undefined);
      return c.text("ok");
    });
    expect((await app.request("/v1/records")).status).toBe(200);
    expect(String(log.mock.calls[0]![0])).toMatch(/ db=2tx\/\d+ms wait=\d+ms$/);
  });
});
