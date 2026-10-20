import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { commitFinalSaveFixture, seedFinalSaveEngine } from "./final-save-test-fixtures.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";
import { ensureFinalSaveRecovery } from "./final-save-recovery.js";
import { confirmWorkspaceDeletion } from "./deletion-test-fixtures.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";

const directory = new URL("../../migrations/", import.meta.url);
const cutoff = "0171_cloud_final_save_recovery.sql";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("pre-recovery cancelled compute Stop history", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => pool.end());
  async function migrate(before: boolean) {
    const client = await pool.connect();
    try {
      for (const name of (await readdir(directory)).filter(name => /^\d{4}_.+\.sql$/.test(name)
        && (before ? name < cutoff : name >= cutoff)).sort()) {
        await client.query("BEGIN");
        try { await client.query(await readFile(new URL(name, directory), "utf8")); await client.query("COMMIT"); }
        catch (error) { await client.query("ROLLBACK"); throw error; }
      }
    } finally { client.release(); }
  }
  beforeEach(async () => {
    await pool.end();
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());`);
    await migrate(true);
  }, 30_000);

  async function scenario(options: { saved?: boolean; dispatched?: boolean; mandatory?: boolean } = {}) {
    const f = await seedReadyCloudWorkspace(pool), stopId = randomUUID(), requestId = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,operation,state,completed_at,idempotency_key,request_sha256,error_code,dispatched_at)
      VALUES($1::uuid,$2,$3,1,'stop','superseded',clock_timestamp(),'system:compute-stop:'||$1::text,
        digest($1::text,'sha256'),'workspace_active',CASE WHEN $4 THEN clock_timestamp() END)`,
    [stopId,f.workspaceId,f.organizationId,options.dispatched ?? false]);
    // Lifecycle dispatch and checkpoint delivery are different facts: the
    // observed legacy cancellation had three actual capture deliveries.
    await pool.query(`INSERT INTO workspace_checkpoint_requests
      (id,workspace_id,org_id,generation,lifecycle_intent_id,reason,state,idempotency_key,deadline_at,
       completed_at,error_code,delivery_count,last_delivered_at)
      VALUES($1::uuid,$2,$3,1,$4::uuid,'before_stop','cancelled','compute.'||$4::text,clock_timestamp()+interval '5 minutes',
        clock_timestamp(),'workspace_active',3,clock_timestamp())`, [requestId,f.workspaceId,f.organizationId,stopId]);
    if (options.mandatory) await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (workspace_id,org_id,generation,requested_by,operation,state,completed_at,idempotency_key,request_sha256,resume_after_intent_id)
      VALUES($1,$2,1,$3,'wake','succeeded',clock_timestamp(),$4,digest($4::text,'sha256'),$5)`,
    [f.workspaceId,f.organizationId,f.userId,randomUUID(),stopId]);
    await migrate(false);
    await pool.query("UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1", [f.workspaceId]);
    await withSystemTx(pool, tx => retireCloudWorkspaceRuntimeAccess(tx, { ...f,reason:"engine_unavailable" }));
    const successor = await withSystemTx(pool, tx => seedFinalSaveEngine(tx, { ...f,userId:f.userId,setupAttempt:2 }));
    const deletionId = randomUUID();
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,1,$4,'delete',$1::text,digest($1::text,'sha256'))`,
    [deletionId,f.workspaceId,f.organizationId,f.userId]));
    if (options.saved !== false) await commitFinalSaveFixture(pool, successor,
      { intentId:deletionId,userId:f.userId,reason:"before_delete" });
    await confirmWorkspaceDeletion(pool, f);
    const jobId = (await pool.query(`INSERT INTO workspace_deletion_jobs
      (workspace_id,org_id,requested_by,idempotency_key) VALUES($1,$2,$3,$4) RETURNING id`,
    [f.workspaceId,f.organizationId,f.userId,randomUUID()])).rows[0].id as string;
    const capture = (await pool.query("SELECT to_jsonb(q) AS value FROM workspace_checkpoint_requests q WHERE id=$1", [requestId])).rows[0].value;
    expect(capture).toMatchObject({ delivery_count:3,state:"cancelled",final_save_recovery_id:null });
    expect((await pool.query("SELECT cloud_workspace_drain_is_mandatory($1) AS mandatory", [stopId])).rows[0].mandatory)
      .toBe(options.mandatory ?? false);
    return { ...f,stopId,requestId,deletionId,jobId,capture };
  }

  it("does not enroll a retired nonmandatory compute Stop through the erasure worker", async () => {
    const f = await scenario();
    const logger = { error:vi.fn() }, objects = { deleteUnreferencedSystem:vi.fn(async () => "already_deleted" as const) };
    expect(await new CloudWorkspaceOperationsWorker(pool, objects, { workerId:"retired-history",logger }).processDeletionOnce()).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.stopId])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT state FROM workspace_deletion_jobs WHERE id=$1", [f.jobId])).rows[0].state).toBe("deleting_objects");
    expect((await pool.query("SELECT to_jsonb(q) AS value FROM workspace_checkpoint_requests q WHERE id=$1", [f.requestId])).rows[0].value).toEqual(f.capture);
    expect(logger.error).not.toHaveBeenCalled();
  }, 30_000);

  it("keeps SQL enrollment and old erasure claims on the same retired-history rule", async () => {
    const f = await scenario();
    await withSystemTx(pool, tx => ensureFinalSaveRecovery(tx, f.stopId));
    const result = await withSystemTx(pool, tx => tx.query(`UPDATE workspace_deletion_jobs
      SET lease_owner='old-erasure',lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1 RETURNING id`, [f.jobId]))
      .then(value => ({ value,error:undefined }), error => ({ value:undefined,error }));
    expect(result.error).toBeUndefined();
    expect(result.value?.rowCount).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.stopId])).rows[0].n).toBe(0);
  }, 30_000);

  it.each(["mandatory","dispatched","unsaved Delete"])("control: retains %s obligations", async kind => {
    const f = await scenario({ mandatory:kind==="mandatory",dispatched:kind==="dispatched",saved:kind!=="unsaved Delete" });
    expect((await pool.query("SELECT cloud_final_save_deletion_claimable($1,$2) AS allowed", [f.workspaceId,f.organizationId])).rows[0].allowed).toBe(false);
    await expect(withSystemTx(pool, tx => tx.query(`UPDATE workspace_deletion_jobs
      SET lease_owner='old-erasure',lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1`, [f.jobId])))
      .rejects.toMatchObject({ code:"40001" });
  }, 30_000);
});
