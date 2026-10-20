import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "./test-database.js";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { ownerDiscardDeleteRequest, seedOwnerDiscardDelete } from "./cloud-workspaces/owner-discard-delete-test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("owner-discard Delete after an engine-health Stop", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetMigratedTestDatabase(pool));
  const options = () => ({ databaseUrl: process.env.TEST_DATABASE_URL! });
  async function fixture() {
    const f = await seedOwnerDiscardDelete(pool, { engineFailureStop: true });
    return { ...f, request: await ownerDiscardDeleteRequest(pool, f) };
  }

  it("admits the actual expired-engine Stop and preserves its undelivered final-save facts", async () => {
    const f = await fixture();
    expect((await pool.query(`SELECT intent.idempotency_key,intent.attempt_count,intent.dispatched_at,
      intent.requested_by,lease.stop_intent_id FROM cloud_workspace_lifecycle_intents intent
      JOIN managed_compute_allocation_leases lease ON lease.stop_intent_id=intent.id WHERE intent.id=$1`, [f.stopId])).rows)
      .toEqual([{ idempotency_key: expect.stringMatching(/^system:engine-stop:/), attempt_count: 0,
        dispatched_at: null, requested_by: null, stop_intent_id: f.stopId }]);
    const capture = (await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1", [f.requestId])).rows[0];
    expect(capture).toMatchObject({ state: "expired", delivery_count: 0, last_delivered_at: null,
      checkpoint_id: null, final_save_capture_report: null, final_save_commit_report: null, final_save_reconcile_report: null });
    const recovery = (await pool.query("SELECT * FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.stopId])).rows[0];
    expect(recovery).toMatchObject({ state: "blocked", engine_instance_id: f.current.engineInstanceId,
      allocation_lease_id: f.wakeId, writer_epoch: f.writerEpoch, checkpoint_id: null, proven_request_id: null });
    const planned = await manageCloudOwnerDiscardDelete(pool, f.request, options());
    expect(planned).toMatchObject({ state: "planned", deleteIntentId: null, providerDeletion: "pending", dataErasure: "pending" });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts")).rows[0].n).toBe(0);
    const accepted = await manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: planned.approval });
    expect(accepted).toMatchObject({ state: "deleting", providerDeletion: "pending", dataErasure: "pending" });
    expect((await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1", [f.requestId])).rows[0]).toEqual(capture);
    expect((await pool.query("SELECT * FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.stopId])).rows[0])
      .toEqual({ ...recovery, state: "discarded", next_attempt_at: Infinity });
    expect((await pool.query("SELECT state,error_code,affects_workspace FROM cloud_workspace_lifecycle_intents WHERE id=$1", [f.stopId])).rows[0])
      .toEqual({ state: "superseded", error_code: "owner_discarded", affects_workspace: false });
    expect((await pool.query("SELECT cloud_final_save_proven($1) AS proven,cloud_final_save_dispatchable($1) AS allowed", [accepted.deleteIntentId])).rows[0])
      .toEqual({ proven: false, allowed: true });
    expect((await pool.query("SELECT sealed_sequence,seal_ack FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1", [f.writerEpoch])).rows[0])
      .toEqual({ sealed_sequence: null, seal_ack: null });
    expect(await manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: planned.approval }))
      .toEqual({ ...accepted, state: "unchanged" });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='delete'", [f.workspaceId])).rows[0].n).toBe(1);
  });

  it.each(["attempted", "dispatched", "live", "differentAllocationStop", "unsupportedStop", "delivered"] as const)(
    "refuses the %s engine-stop variant without writing a receipt or Delete", async changed => {
      const f = await fixture();
      if (changed === "attempted") await pool.query("UPDATE cloud_workspace_lifecycle_intents SET attempt_count=1 WHERE id=$1", [f.stopId]);
      if (changed === "dispatched") await pool.query("UPDATE cloud_workspace_lifecycle_intents SET dispatched_at=clock_timestamp() WHERE id=$1", [f.stopId]);
      if (changed === "live") {
        await pool.query(`UPDATE cloud_workspace_endpoint_grants SET revoked_at=NULL,expires_at=now()+interval '10 minutes'
          WHERE id=(SELECT registration_grant_id FROM cloud_workspace_engine_instances WHERE id=$1)`, [f.current.engineInstanceId]);
        await pool.query(`UPDATE cloud_workspace_engine_instances SET state='ready',revoked_at=NULL,
          lease_expires_at=now()+interval '1 minute' WHERE id=$1`, [f.current.engineInstanceId]);
      }
      if (changed === "differentAllocationStop") await pool.query("UPDATE managed_compute_allocation_leases SET stop_intent_id=$2 WHERE id=$1", [f.wakeId, f.wakeId]);
      if (changed === "unsupportedStop") await pool.query("UPDATE cloud_workspace_lifecycle_intents SET idempotency_key='system:engine-exit:'||id::text WHERE id=$1", [f.stopId]);
      if (changed === "delivered") await pool.query("UPDATE workspace_checkpoint_requests SET delivery_count=1,last_delivered_at=created_at WHERE id=$1", [f.requestId]);
      await expect(manageCloudOwnerDiscardDelete(pool, f.request, options())).rejects.toMatchObject({ code: "owner_delete_source_unavailable" });
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts")).rows[0].n).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='delete'", [f.workspaceId])).rows[0].n).toBe(0);
    });
});
