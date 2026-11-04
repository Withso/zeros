import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool, createMigrationPool, withSystemTx } from "./db.js";
import { withWorkOSProviderLocks } from "./workos-provider-locks.js";
import { workosTestEnv } from "./test-workos-env.js";

const url = process.env.TEST_DATABASE_URL;
const database = url ? describe : describe.skip;
afterEach(() => vi.useRealTimers());

database("database workload bulkheads", () => {
  it("keeps API and migration capacity available while both worker slots are held", async () => {
    const api = createPool(url!, { workload: "api" });
    const worker = createPool(url!, { workload: "worker" });
    const migration = createMigrationPool(url!);
    const held: pg.PoolClient[] = [];
    try {
      for (let index = 0; index < 2; index++) held.push(await worker.connect());
      expect(worker.idleCount).toBe(0);
      expect((await api.query("SHOW statement_timeout")).rows).toEqual([{ statement_timeout: "5s" }]);
      expect((await migration.query("SHOW statement_timeout")).rows).toEqual([{ statement_timeout: "30s" }]);
      await expect(withSystemTx(api, async tx => (await tx.query("SELECT 1 AS value")).rows[0].value)).resolves.toBe(1);
      expect(api.options.max).toBe(6);
      expect(worker.options.max).toBe(2);
      expect(migration.options.max).toBe(1);
    } finally {
      held.forEach(client => client.release());
      await Promise.all([api.end(), worker.end(), migration.end()]);
    }
  });

  it("expires promise, callback and query waiters at one second without a late acquisition leak", async () => {
    const api = createPool(url!, { workload: "api", maxConnections: 2 });
    const held = [await api.connect(), await api.connect()];
    const settled: unknown[] = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const promise = api.connect().then(client => { client.release(); return null; }, error => error)
      .then(result => { settled.push(result); });
    const callback = new Promise<void>(resolve => api.connect((error, client, release) => {
      if (client) release();
      settled.push(error ?? null); resolve();
    }));
    const query = api.query("SELECT 1").then(() => null, error => error)
      .then(result => { settled.push(result); });
    try {
      expect(api.waitingCount).toBe(3);
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveLength(3);
      for (const error of settled) expect(error).toMatchObject({ code: "database_acquire_timeout" });
      expect(api.waitingCount).toBe(0);
    } finally {
      vi.useRealTimers();
      held.forEach(client => client.release());
      await Promise.all([promise, callback, query]);
      expect(api.idleCount).toBe(2);
      await api.end();
    }
  });

  it("returns a bounded retry response when even a public health request cannot acquire", async () => {
    const api = createPool(url!, { workload: "api", maxConnections: 2 });
    const held = [await api.connect(), await api.connect()];
    const config = loadConfig({ DATABASE_URL: url!, ...workosTestEnv(), AUTH_AUDIENCE: "https://api.example.test" });
    const app = createApp(config, api, { from: null, apiKey: null } as never);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let response: Response | undefined;
    const pending = app.request("/healthz").then(value => { response = value; });
    try {
      // The real route has reached pg-pool before its acquire clock advances.
      await vi.waitFor(() => expect(api.waitingCount).toBe(1));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(response?.status).toBe(503);
      expect(response?.headers.get("retry-after")).toBe("1");
      expect(response?.headers.get("cache-control")).toBe("no-store");
    } finally {
      vi.useRealTimers(); held.forEach(client => client.release());
      await pending; await api.end();
    }
  });

  it("allows a WorkOS lock holder to checkpoint on its two-slot worker pool while API is full", async () => {
    const api = createPool(url!, { workload: "api", maxConnections: 2 });
    const worker = createPool(url!, { workload: "worker" });
    const held = [await api.connect(), await api.connect()];
    try {
      await expect(withWorkOSProviderLocks(worker, [`bulkhead:${randomUUID()}`], () =>
        withSystemTx(worker, async tx => (await tx.query("SELECT 1 AS value")).rows[0].value),
      )).resolves.toBe(1);
      expect(worker.totalCount).toBe(2);
      expect(worker.waitingCount).toBe(0);
    } finally {
      held.forEach(client => client.release());
      await Promise.all([api.end(), worker.end()]);
    }
  });
});
