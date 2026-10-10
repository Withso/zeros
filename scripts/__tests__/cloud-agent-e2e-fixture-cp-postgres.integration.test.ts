import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Db } from "../../apps/control-plane/src/db";
import { createPostgresCostSampler } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/postgres-cost";

const enabled = process.env.TEST_DATABASE_URL && process.env.TEST_OBSERVER_DATABASE_URL;
const d = enabled ? describe : describe.skip;
d("real PostgreSQL aggregate cost sampling on two owned databases", () => {
  const table = `w6_cost_statistics_${randomUUID().replaceAll("-", "")}`;
  let monitor: Db;
  const producer = () => createPool(process.env.TEST_DATABASE_URL!, { maxConnections: 1, applicationName: "zeros-w6-cost-producer" });
  beforeAll(async () => {
    if (new URL(process.env.TEST_DATABASE_URL!).pathname !== "/test_w6" ||
        new URL(process.env.TEST_OBSERVER_DATABASE_URL!).pathname !== "/test_w6_monitor") throw new Error("fixture_statistics_database_not_owned");
    monitor = createPool(process.env.TEST_OBSERVER_DATABASE_URL!, { maxConnections: 1, applicationName: "zeros-w6-cost-monitor" });
    const setup = producer();
    try { await setup.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, payload text NOT NULL)`); }
    finally { await setup.end(); }
  });
  afterAll(async () => {
    const cleanup = producer();
    try { await cleanup.query(`DROP TABLE IF EXISTS ${table}`); }
    finally { await cleanup.end(); await monitor?.end(); }
  });

  it("captures known INSERT/UPDATE/DELETE and rollback after positive producer retirement", async () => {
    const sampler = createPostgresCostSampler({ monitorPool: monitor, targetDatabase: "test_w6" });
    const start = await sampler.checkpoint(), writes = producer();
    try {
      await writes.query("BEGIN");
      await writes.query(`INSERT INTO ${table} VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
      await writes.query(`UPDATE ${table} SET payload='updated'`);
      await writes.query(`DELETE FROM ${table} WHERE id=3`);
      await writes.query("COMMIT");
      await writes.query("BEGIN");
      await writes.query(`INSERT INTO ${table} VALUES (4, 'rolled-back')`);
      await writes.query("ROLLBACK");
    } finally { await writes.end(); }
    const end = await sampler.checkpoint(), window = sampler.window(start, end);
    expect(start.drainProof).toBe("target-backends-exited");
    expect(end.drainProof).toBe("target-backends-exited");
    expect(BigInt(window.database.xactCommit)).toBeGreaterThanOrEqual(1n);
    expect(BigInt(window.database.xactRollback)).toBeGreaterThanOrEqual(1n);
    expect(BigInt(window.database.tuplesInserted)).toBeGreaterThanOrEqual(3n);
    expect(BigInt(window.database.tuplesUpdated)).toBeGreaterThanOrEqual(3n);
    expect(BigInt(window.database.tuplesDeleted)).toBeGreaterThanOrEqual(1n);
    expect(window).toMatchObject({ databaseComplete: true, statementsComplete: false, statementUnavailableReason: "not-enabled",
      successfulStatementCalls: null, statementRowsRetrievedOrAffected: null, sqlWriteStatements: null, encodedPersistedBytes: null });
    const verify = producer();
    try { expect((await verify.query(`SELECT count(*)::text AS count FROM ${table}`)).rows).toEqual([{ count: "2" }]); }
    finally { await verify.end(); }
  });

  it("does not certify a snapshot while a target producer connection remains", async () => {
    const active = producer();
    try {
      await active.query("SELECT 1");
      const sampler = createPostgresCostSampler({ monitorPool: monitor, targetDatabase: "test_w6", drainTimeoutMs: 0 });
      await expect(sampler.checkpoint()).rejects.toThrow("postgres_cost_target_not_drained");
    } finally { await active.end(); }
  });

  it("takes fresh samples across successive windows instead of reusing a cached zero", async () => {
    const sampler = createPostgresCostSampler({ monitorPool: monitor, targetDatabase: "test_w6" });
    let start = await sampler.checkpoint();
    for (const id of [5, 6]) {
      const writes = producer();
      try { await writes.query(`INSERT INTO ${table} VALUES ($1, 'fresh')`, [id]); }
      finally { await writes.end(); }
      const end = await sampler.checkpoint();
      expect(BigInt(sampler.window(start, end).database.tuplesInserted)).toBeGreaterThanOrEqual(1n);
      start = end;
    }
  });
});
