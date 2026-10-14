import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { withSystemTx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import {
  assertCurrentCloudEngineAuthority,
  CloudWorkspaceEngineAuthorityError,
  readCurrentCloudEngineAuthority,
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
    await resetMigratedTestDatabase(pool);
    const f = await seedReadyCloudWorkspace(pool);
    scope = { workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1,
      engineInstanceId: f.engineInstanceId, heartbeatToken: f.heartbeatToken, workosEnabled: false };
  });
  const authorize = () => withSystemTx(pool, tx => assertCurrentCloudEngineAuthority(tx, scope));

  it("bounds the read projection by the original transaction and engine lease", async () => {
    await pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=clock_timestamp()+interval '4 seconds' WHERE id=$1", [scope.engineInstanceId]);
    await withSystemTx(pool, async tx => {
      const clock = (await tx.query<{ started: Date; expires: Date }>(`SELECT transaction_timestamp() AS started,lease_expires_at AS expires
        FROM cloud_workspace_engine_instances WHERE id=$1`, [scope.engineInstanceId])).rows[0]!;
      const read = await readCurrentCloudEngineAuthority(tx, scope);
      expect(read).toMatchObject({ version: 1, engineInstanceId: scope.engineInstanceId, generation: scope.generation });
      expect(read.confirmedUntilMs).toBe(clock.expires.getTime());
      expect(read.confirmedUntilMs).toBeLessThanOrEqual(clock.started.getTime() + 10_000);
    }, { consistentRead: true });
  });

  it.each(["heartbeat", "workspace", "organization", "generation", "engine"] as const)("refuses a foreign %s in the read projection", async field => {
    const foreign = { ...scope };
    if (field === "heartbeat") foreign.heartbeatToken = `zwh_${randomBytes(32).toString("base64url")}`;
    else if (field === "generation") foreign.generation++;
    else if (field === "workspace") foreign.workspaceId = randomUUID();
    else if (field === "organization") foreign.organizationId = randomUUID();
    else foreign.engineInstanceId = randomUUID();
    await expect(withSystemTx(pool, tx => readCurrentCloudEngineAuthority(tx, foreign), { consistentRead: true }))
      .rejects.toBeInstanceOf(CloudWorkspaceEngineAuthorityError);
  });

  it.each(["lease", "final-checkpoint", "revoked"] as const)("refuses %s engine authority in the read projection", async fence => {
    if (fence === "lease") await pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=clock_timestamp() WHERE id=$1", [scope.engineInstanceId]);
    else if (fence === "final-checkpoint") await pool.query("UPDATE cloud_workspace_engine_instances SET final_checkpoint_at=clock_timestamp() WHERE id=$1", [scope.engineInstanceId]);
    else await pool.query("UPDATE cloud_workspace_engine_instances SET revoked_at=clock_timestamp(),state='revoked' WHERE id=$1", [scope.engineInstanceId]);
    await expect(withSystemTx(pool, tx => readCurrentCloudEngineAuthority(tx, scope), { consistentRead: true }))
      .rejects.toBeInstanceOf(CloudWorkspaceEngineAuthorityError);
  });

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
