import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { withSystemTx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import {
  assertCurrentCloudEngineAuthority,
  CloudWorkspaceEngineAuthorityError,
} from "./engine-authority.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("cloud engine authority fence", () => {
  let pool: pg.Pool;
  let scope: {
    workspaceId: string; organizationId: string; generation: number;
    engineInstanceId: string; heartbeatToken: string; workosEnabled: boolean;
  };
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); await runMigrations(pool);
    const f = await seedReadyCloudWorkspace(pool);
    scope = { workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1,
      engineInstanceId: f.engineInstanceId, heartbeatToken: f.heartbeatToken, workosEnabled: false };
  });
  const authorize = () => withSystemTx(pool, tx => assertCurrentCloudEngineAuthority(tx, scope));

  /** Hold the engine row while an exclusive authority check evaluates its
   * predicate and then waits; release after the lease, or after 100 ms. */
  async function waitBehindHeldEngine(expiresInMs: number, releaseAfterLease: boolean) {
    await pool.query(`UPDATE cloud_workspace_engine_instances
      SET lease_expires_at=clock_timestamp()+make_interval(secs=>$2::double precision/1000) WHERE id=$1`,
    [scope.engineInstanceId, expiresInMs]);
    const held = await pool.connect();
    try {
      await held.query("BEGIN");
      await held.query("SELECT id FROM cloud_workspace_engine_instances WHERE id=$1 FOR SHARE", [scope.engineInstanceId]);
      const pending = authorize().then(value => ({ value }), (error: unknown) => ({ error }));
      for (let attempt = 0; attempt < 200; attempt++) {
        const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE '%cloud_workspace_engine_authority_current%'`);
        if (waiting.rowCount) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const [{ remaining }] = (await pool.query<{ remaining: number }>(`SELECT greatest(0,
        extract(epoch FROM lease_expires_at-clock_timestamp())*1000)::float8 AS remaining
        FROM cloud_workspace_engine_instances WHERE id=$1`, [scope.engineInstanceId])).rows;
      await new Promise(resolve => setTimeout(resolve, releaseAfterLease ? remaining + 50 : 100));
      await held.query("ROLLBACK");
      return await pending;
    } finally { held.release(); }
  }

  it("rejects a lease that expires while the engine lock waits", async () => {
    await expect(authorize()).resolves.toMatchObject({ engineInstanceId: scope.engineInstanceId });
    const outcome = await waitBehindHeldEngine(400, true);
    expect(outcome).toMatchObject({ error: expect.any(CloudWorkspaceEngineAuthorityError) });
  });

  it("admits a waiting request whose lease is still live after the lock", async () => {
    const outcome = await waitBehindHeldEngine(60_000, false);
    expect(outcome).toMatchObject({ value: { engineInstanceId: scope.engineInstanceId } });
  });
});
