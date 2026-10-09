import { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, withSystemTx } from "./db.js";
import { recordDatabasePersistenceCost, requestTiming, type RequestDatabaseCost } from "./request-timing.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("real pg query-port cost observations", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = createPool(process.env.TEST_DATABASE_URL!, { maxConnections: 2 }); });
  afterAll(async () => { await pool.end(); });
  const appWithCosts = () => {
    const summaries: RequestDatabaseCost[] = [];
    const app = new Hono();
    app.use("*", requestTiming({ slowMs: Number.POSITIVE_INFINITY, databasePool: pool,
      costObserver: summary => { summaries.push(summary); } }));
    return { app, summaries };
  };

  it("observes the driver's multi-result BEGIN and actual INSERT without altering returned rows", async () => {
    const { app, summaries } = appWithCosts();
    app.post("/cost", async c => {
      const values = ["é", "漢"];
      const rows = await withSystemTx(pool, async tx => {
        const created = await tx.query("CREATE TEMP TABLE request_cost_rows (payload text NOT NULL) ON COMMIT DROP");
        recordDatabasePersistenceCost(created, { writeStatements: 1, affectedRows: 0, encodedPersistedBytes: 0 });
        const inserted = await tx.query<{ payload: string }>("INSERT INTO request_cost_rows VALUES ($1), ($2) RETURNING payload", values);
        recordDatabasePersistenceCost(inserted, { affectedRows: inserted.rowCount!,
          encodedPersistedBytes: values.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0) });
        const retained = await tx.query<{ payload: string }>("SELECT payload FROM request_cost_rows");
        expect(retained.rows).toEqual(inserted.rows);
        return retained.rows;
      });
      return c.json(rows);
    });
    const response = await app.request("/cost", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ payload: "é" }, { payload: "漢" }]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ queriesStarted: 5, queriesCompleted: 5, sqlStatements: 7,
      transactions: 1, commits: 1, rollbacks: 0, sqlWriteStatements: 2, observedAffectedRows: 2,
      affectedRows: 2, encodedPersistedBytes: 5, committedEncodedPersistedBytes: 5, complete: true });
  });

  it("retains actual rolled-back work and never reports it as committed encoded payload", async () => {
    const { app, summaries } = appWithCosts();
    const original = new Error("synthetic rollback control");
    app.post("/cost", async c => {
      await expect(withSystemTx(pool, async tx => {
        const created = await tx.query("CREATE TEMP TABLE request_cost_rows (payload text NOT NULL) ON COMMIT DROP");
        recordDatabasePersistenceCost(created, { writeStatements: 1, affectedRows: 0, encodedPersistedBytes: 0 });
        const inserted = await tx.query("INSERT INTO request_cost_rows VALUES ($1)", ["é"]);
        recordDatabasePersistenceCost(inserted, { affectedRows: inserted.rowCount!, encodedPersistedBytes: 2 });
        throw original;
      })).rejects.toBe(original);
      return c.text("handled");
    });
    expect((await app.request("/cost", { method: "POST" })).status).toBe(200);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ queriesStarted: 4, queriesCompleted: 4, sqlStatements: 6,
      transactions: 1, commits: 0, rollbacks: 1, sqlWriteStatements: 2, affectedRows: 1,
      encodedPersistedBytes: 2, committedEncodedPersistedBytes: 0, complete: true });
  });
});
