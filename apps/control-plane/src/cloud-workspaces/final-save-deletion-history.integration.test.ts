import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { withSystemTx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { seedRecordedCloudWorkspaceActor } from "./recorded-actor-test-fixture.js";
import { commitFinalSaveFixture } from "./final-save-test-fixtures.js";
import { DatabaseCloudIdleStop } from "./idle-stop.js";
import { ensureFinalSaveRecovery, finalSaveProven } from "./final-save-recovery.js";
import { CloudWorkspaceCheckpointRequestWorker } from "./checkpoint-requests.js";
import { confirmWorkspaceDeletion } from "./deletion-test-fixtures.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("W2 final save and cancelled idle history", () => {
  let pool: InstanceType<typeof pg.Pool>;
  beforeAll(() => {
    if (!process.env.TEST_DATABASE_URL) throw new Error("Real local PostgreSQL is required");
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
  });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });

  async function scenario(idleHistory: boolean, saved: boolean) {
    const f = await seedReadyCloudWorkspace(pool);
    const scope = { ...f, generation: 1 };
    if (idleHistory) {
      const actor = await seedRecordedCloudWorkspaceActor(pool, f);
      await pool.query("UPDATE cloud_workspace_engine_instances SET created_at=clock_timestamp()-interval '11 minutes' WHERE id=$1", [f.engineInstanceId]);
      const idle = new DatabaseCloudIdleStop(pool, false);
      const directive = await idle.request(actor, randomUUID());
      expect(directive?.idleStop).toBe(true);
      await idle.cancel(actor, directive!.id);
      const historical = (await pool.query(`SELECT request.state,request.lifecycle_intent_id,intent.state AS intent_state
        FROM workspace_checkpoint_requests request JOIN cloud_workspace_lifecycle_intents intent ON intent.id=request.lifecycle_intent_id
        WHERE request.id=$1`, [directive!.id])).rows[0];
      expect(historical).toMatchObject({ state: "cancelled", intent_state: "superseded" });
      await withSystemTx(pool, tx => ensureFinalSaveRecovery(tx, historical.lifecycle_intent_id));
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [historical.lifecycle_intent_id])).rows[0].n).toBe(0);
    }
    const intentId = randomUUID();
    await withSystemTx(pool, async tx => {
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [f.organizationId]);
      await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
      await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
        VALUES($1::uuid,$2,$3,1,$4,'delete',$1::text,digest($1::text,'sha256'))`, [intentId, f.workspaceId, f.organizationId, f.userId]);
    });
    if (saved) await commitFinalSaveFixture(pool, scope, { intentId, userId: f.userId, reason: "before_delete" });
    expect(await withSystemTx(pool, tx => finalSaveProven(tx, intentId))).toBe(saved);
    return { ...f, intentId };
  }

  it("control: an unsaved delete remains ineligible", async () => {
    const f = await scenario(false, false);
    const result = await withSystemTx(pool, tx => tx.query("SELECT cloud_final_save_deletion_claimable($1,$2) AS allowed", [f.workspaceId,f.organizationId]));
    expect(result.rows[0].allowed).toBe(false);
  });

  it("control: a saved delete without idle history is eligible", async () => {
    const f = await scenario(false, true);
    const result = await withSystemTx(pool, tx => tx.query("SELECT cloud_final_save_deletion_claimable($1,$2) AS allowed", [f.workspaceId,f.organizationId]));
    expect(result.rows[0].allowed).toBe(true);
  });

  it("a truthfully cancelled idle stop must not block a later saved delete", async () => {
    const f = await scenario(true, true);
    const result = await withSystemTx(pool, tx => tx.query("SELECT cloud_final_save_deletion_claimable($1,$2) AS allowed", [f.workspaceId,f.organizationId]));
    expect(result.rows[0].allowed).toBe(true);
  });

  it.each([false, true])("the current erasure worker with cancelled idle history admits saved=%s", async saved => {
    const f = await scenario(true, saved);
    await confirmWorkspaceDeletion(pool, f);
    const job = (await pool.query<{ id: string }>(`INSERT INTO workspace_deletion_jobs
      (workspace_id,org_id,requested_by,idempotency_key) VALUES($1,$2,$3,$4) RETURNING id`,
    [f.workspaceId,f.organizationId,f.userId,randomUUID()])).rows[0]!;
    const objects = { deleteUnreferencedSystem: vi.fn(async () => "already_deleted" as const) };
    const logger = { error: vi.fn() };
    const worker = new CloudWorkspaceOperationsWorker(pool, objects, { workerId: "idle-history-erasure", logger });
    expect(await worker.processDeletionOnce()).toBe(saved);
    expect((await pool.query("SELECT state,error_code FROM workspace_deletion_jobs WHERE id=$1", [job.id])).rows[0])
      .toEqual({ state: saved ? "deleting_objects" : "waiting_for_provider", error_code: null });
    expect(logger.error).not.toHaveBeenCalled();
    expect(objects.deleteUnreferencedSystem).not.toHaveBeenCalled();
  });

  async function idleHistory(f: Awaited<ReturnType<typeof scenario>>) {
    return (await pool.query<{ id: string; lifecycle_intent_id: string }>(
      "SELECT id,lifecycle_intent_id FROM workspace_checkpoint_requests WHERE workspace_id=$1 AND idle_engine_instance_id IS NOT NULL",
      [f.workspaceId],
    )).rows[0]!;
  }

  const claimable = async (f: Awaited<ReturnType<typeof scenario>>) =>
    (await withSystemTx(pool, tx => tx.query(
      "SELECT cloud_final_save_deletion_claimable($1,$2) AS allowed", [f.workspaceId,f.organizationId],
    ))).rows[0].allowed as boolean;

  async function oldErasureClaim(f: Awaited<ReturnType<typeof scenario>>, state: string) {
    const job = (await pool.query<{ id: string }>(`INSERT INTO workspace_deletion_jobs
      (workspace_id,org_id,requested_by,idempotency_key,state) VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [f.workspaceId,f.organizationId,f.userId,randomUUID(),state])).rows[0]!;
    return withSystemTx(pool, tx => tx.query(`UPDATE workspace_deletion_jobs SET lease_owner='legacy-erasure',
      lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1 RETURNING id`, [job.id]));
  }

  it.each(["failed", "superseded"] as const)("accepts retired idle %s history for every unsuccessful terminal request", async state => {
    const f = await scenario(true, true), historical = await idleHistory(f);
    for (const requestState of ["cancelled", "expired", "failed"]) {
      await pool.query("UPDATE workspace_checkpoint_requests SET state=$2,completed_at=clock_timestamp() WHERE id=$1", [historical.id,requestState]);
      await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state=$2,completed_at=clock_timestamp() WHERE id=$1", [historical.lifecycle_intent_id,state]);
      expect(await claimable(f), `${state}/${requestState}`).toBe(true);
    }
  });

  it.each(["waiting_for_provider", "deleting_objects", "deleting_records"])("admits an N-1 %s erasure claim only after the current Delete is saved", async state => {
    const f = await scenario(true, true);
    expect((await oldErasureClaim(f, state)).rowCount).toBe(1);
  });

  it.each(["waiting_for_provider", "deleting_objects", "deleting_records"])("keeps an unsaved Delete behind the N-1 %s guard despite cancelled idle history", async state => {
    const f = await scenario(true, false);
    expect(await claimable(f)).toBe(false);
    await expect(oldErasureClaim(f, state)).rejects.toMatchObject({ code: "40001" });
  });

  it("retires a real idle deadline without making it accepted final-save recovery", async () => {
    const f = await seedReadyCloudWorkspace(pool), actor = await seedRecordedCloudWorkspaceActor(pool, f);
    await pool.query("UPDATE cloud_workspace_engine_instances SET created_at=clock_timestamp()-interval '11 minutes' WHERE id=$1", [f.engineInstanceId]);
    const request = (await new DatabaseCloudIdleStop(pool, false).request(actor, randomUUID()))!;
    await pool.query(`UPDATE workspace_checkpoint_requests SET created_at=clock_timestamp()-interval '6 minutes',
      deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [request.id]);
    expect(await new CloudWorkspaceCheckpointRequestWorker(pool).expireOnce()).toBe(1);
    const historical = (await pool.query(`SELECT request.state,intent.state AS intent_state FROM workspace_checkpoint_requests request
      JOIN cloud_workspace_lifecycle_intents intent ON intent.id=request.lifecycle_intent_id WHERE request.id=$1`, [request.id])).rows[0];
    expect(historical).toEqual({ state: "expired", intent_state: "failed" });
    const intentId = randomUUID();
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,1,$4,'delete',$1::text,digest($1::text,'sha256'))`, [intentId,f.workspaceId,f.organizationId,f.userId]));
    await commitFinalSaveFixture(pool, { ...f,generation:1 }, { intentId,userId:f.userId,reason:"before_delete" });
    expect(await claimable({ ...f,intentId })).toBe(true);
  });

  it.each([
    ["explicit actor", "UPDATE cloud_workspace_lifecycle_intents SET requested_by=$2 WHERE id=$1"],
    ["explicit key", "UPDATE cloud_workspace_lifecycle_intents SET idempotency_key='explicit-stop-history' WHERE id=$1"],
    ["archive", "UPDATE cloud_workspace_lifecycle_intents SET operation='archive' WHERE id=$1"],
    ["delete", "UPDATE cloud_workspace_lifecycle_intents SET operation='delete' WHERE id=$1"],
    ["already dispatched", "UPDATE cloud_workspace_lifecycle_intents SET dispatched_at=clock_timestamp() WHERE id=$1"],
    ["prior claim", "UPDATE cloud_workspace_lifecycle_intents SET attempt_count=1 WHERE id=$1"],
    ["legacy unsaved success", "UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',error_code='stop_unsealed' WHERE id=$1"],
    ["queued", "UPDATE cloud_workspace_lifecycle_intents SET state='queued',completed_at=NULL WHERE id=$1"],
    ["observing", "UPDATE cloud_workspace_lifecycle_intents SET state='observing',completed_at=NULL WHERE id=$1"],
  ])("does not treat %s historical intent as reversible cancellation", async (name,sql) => {
    const f = await scenario(true, true), historical = await idleHistory(f);
    await pool.query(sql, name === "explicit actor" ? [historical.lifecycle_intent_id,f.userId] : [historical.lifecycle_intent_id]);
    expect(await claimable(f)).toBe(false);
  });

  it.each(["missing", "explicit", "wrong idle engine", "live"])("requires an exact retired idle request, refusing %s request history", async kind => {
    const f = await scenario(true, true), historical = await idleHistory(f);
    if (kind === "missing") await pool.query("DELETE FROM workspace_checkpoint_requests WHERE id=$1", [historical.id]);
    if (kind === "explicit") await pool.query("UPDATE workspace_checkpoint_requests SET idle_engine_instance_id=NULL WHERE id=$1", [historical.id]);
    if (kind === "wrong idle engine") await pool.query("UPDATE workspace_checkpoint_requests SET idle_engine_instance_id=$2 WHERE id=$1", [historical.id,randomUUID()]);
    if (kind === "live") await pool.query("UPDATE workspace_checkpoint_requests SET state='queued',completed_at=NULL WHERE id=$1", [historical.id]);
    expect(await claimable(f)).toBe(false);
  });

  it("never bypasses an unresolved mandatory idle recovery when a later incarnation saves Delete", async () => {
    const f = await scenario(true, false), historical = await idleHistory(f);
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
        (workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256,resume_after_intent_id)
        VALUES($1,$2,1,$3,'wake',$4,digest($4::text,'sha256'),$5)`,
      [f.workspaceId,f.organizationId,f.userId,randomUUID(),historical.lifecycle_intent_id]);
      await ensureFinalSaveRecovery(tx, historical.lifecycle_intent_id);
    });
    await pool.query("UPDATE cloud_workspace_engine_instances SET registered_at=clock_timestamp() WHERE id=$1", [f.engineInstanceId]);
    const later = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,1,$4,'delete',$1::text,digest($1::text,'sha256'))`, [later,f.workspaceId,f.organizationId,f.userId]);
    await commitFinalSaveFixture(pool, { ...f,generation:1 }, { intentId:later,userId:f.userId,reason:"before_delete" });
    expect(await withSystemTx(pool, tx => finalSaveProven(tx, later))).toBe(true);
    expect(await withSystemTx(pool, tx => finalSaveProven(tx, historical.lifecycle_intent_id))).toBe(false);
    expect(await claimable(f)).toBe(false);
    await expect(oldErasureClaim(f, "deleting_records")).rejects.toMatchObject({ code: "40001" });
  });
});
