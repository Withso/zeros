import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "./db.js";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { seedReadyCloudWorkspace } from "./cloud-workspaces/test-fixtures.js";
import { ensureFinalSaveRecovery } from "./cloud-workspaces/final-save-recovery.js";
import { ownerDiscardDeleteRequest, seedOwnerDiscardDelete } from "./cloud-workspaces/owner-discard-delete-test-fixtures.js";
import { CloudWorkspaceReconciler } from "./cloud-workspaces/reconciler.js";
import { CloudWorkspaceOperationsWorker } from "./cloud-workspaces/operations.js";
import { DatabaseCloudProviderOperationStore } from "./cloud-workspaces/provider-operation-store.js";
import type { CloudProviderResource, CloudWorkspaceProvider } from "./cloud-workspaces/provider.js";

const directory = new URL("../migrations/", import.meta.url);
const first = "0171_cloud_final_save_recovery.sql";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("owner Delete preserves pre-0171 terminal captures", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => pool.end());
  async function migrate(before: boolean) {
    const client = await pool.connect();
    try {
      for (const file of (await readdir(directory)).filter(name => /^\d{4}_.+\.sql$/.test(name) && (before ? name < first : name >= first)).sort()) {
        await client.query("BEGIN");
        try { await client.query(await readFile(new URL(file, directory), "utf8")); await client.query("COMMIT"); }
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

  async function legacy(crashedReady = false) {
    const ready = await seedReadyCloudWorkspace(pool);
    const intentId = randomUUID(), captureId = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,requested_by,operation,state,completed_at,idempotency_key,request_sha256,affects_workspace)
      VALUES($1::uuid,$2,$3,1,$4,'stop','superseded',clock_timestamp(),$1::text,digest($1::text,'sha256'),false)`,
    [intentId,ready.workspaceId,ready.organizationId,ready.userId]);
    await pool.query(`INSERT INTO workspace_checkpoint_requests
      (id,workspace_id,org_id,generation,requested_by,lifecycle_intent_id,reason,state,idempotency_key,created_at,deadline_at,completed_at)
      VALUES($1::uuid,$2,$3,1,$4,$5,'before_stop','cancelled',$1::text,
        clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '5 minutes',clock_timestamp()-interval '4 minutes')`,
    [captureId,ready.workspaceId,ready.organizationId,ready.userId,intentId]);
    await migrate(false);
    const f = await seedOwnerDiscardDelete(pool, { readyFixture: ready, crashedReady });
    const row = (await pool.query("SELECT to_jsonb(request) AS value FROM workspace_checkpoint_requests request WHERE id=$1", [captureId])).rows[0].value;
    expect(row).toMatchObject({ state: "cancelled", final_save_recovery_id: null, final_save_attempt_ordinal: null, final_save_retirement_id: null });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_final_save_recoveries WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(1);
    return { ...f, intentId, captureId, row };
  }

  it("executes the approved Delete without rewriting the migrated cancelled capture", async () => {
    const f = await legacy(), request = await ownerDiscardDeleteRequest(pool, f);
    const options = { databaseUrl: process.env.TEST_DATABASE_URL! };
    const plan = await manageCloudOwnerDiscardDelete(pool, request, options);
    let failedStatement: string | undefined;
    const traced = { connect: async () => {
      const client = await pool.connect();
      return { query: async (text: string, values?: unknown[]) => {
        try { return await client.query(text, values); }
        catch (error) { failedStatement = text; throw error; }
      }, release: () => client.release() };
    } } as unknown as pg.Pool;
    const result = await manageCloudOwnerDiscardDelete(traced, request, { ...options, execute: true, approval: plan.approval })
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    if (result.error) {
      expect(result.error).toMatchObject({ code: "40001", message: "owner delete capture facts are retained" });
      expect(failedStatement).toContain("UPDATE workspace_checkpoint_requests request SET final_save_recovery_id=recovery.lifecycle_intent_id");
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts")).rows[0].n).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_lifecycle_intents WHERE operation='delete'")).rows[0].n).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_final_save_recoveries WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(1);
    }
    expect((await pool.query("SELECT to_jsonb(request) AS value FROM workspace_checkpoint_requests request WHERE id=$1", [f.captureId])).rows[0].value).toEqual(f.row);
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ state: "deleting", providerDeletion: "pending", dataErasure: "pending" });
  }, 30_000);

  it("control: the existing adoption trigger adds a third field to a legacy terminal request", async () => {
    const f = await legacy();
    await withSystemTx(pool, tx => ensureFinalSaveRecovery(tx, f.intentId));
    const after = (await pool.query("SELECT to_jsonb(request) AS value FROM workspace_checkpoint_requests request WHERE id=$1", [f.captureId])).rows[0].value;
    const changes = Object.keys(after).filter(key => JSON.stringify(after[key]) !== JSON.stringify(f.row[key])).sort();
    expect(changes).toEqual(["final_save_attempt_ordinal", "final_save_recovery_id", "final_save_retirement_id"]);
    expect(after).toMatchObject({ state: "cancelled", checkpoint_id: null, final_save_recovery_id: f.intentId, final_save_attempt_ordinal: 0 });
    expect(after.final_save_retirement_id).toEqual(expect.any(String));
  }, 30_000);

  it("control: the ordinary fixture with a linked expired Stop still executes", async () => {
    await migrate(false);
    const f = await seedOwnerDiscardDelete(pool), request = await ownerDiscardDeleteRequest(pool, f);
    const options = { databaseUrl: process.env.TEST_DATABASE_URL! };
    const plan = await manageCloudOwnerDiscardDelete(pool, request, options);
    expect(await manageCloudOwnerDiscardDelete(pool, request, { ...options, execute: true, approval: plan.approval }))
      .toMatchObject({ state: "deleting" });
  }, 30_000);

  it("erases provider storage, objects and records while retaining exact unlinked legacy loss facts", async () => {
    const f = await legacy(true), batchId = randomUUID();
    // Retained record payloads make the purge assertion non-vacuous. The
    // fixture already has durable revision 2 and an unsealed native writer.
    await pool.query(`INSERT INTO workspace_record_batches
      (id,workspace_id,org_id,generation,engine_instance_id,authority_epoch,idempotency_key,request_sha256,
       first_revision,last_revision,event_count)
      VALUES($1::uuid,$2,$3,1,$4,1,$1::text,digest($1::text,'sha256'),1,2,2)`,
    [batchId,f.workspaceId,f.organizationId,f.engineInstanceId]);
    await pool.query(`INSERT INTO workspace_record_events
      (workspace_id,org_id,revision,batch_id,entity_kind,entity_id,operation,document,occurred_at)
      SELECT $1,$2,n,$3,'metadata','legacy-'||n::text,'upsert','{"retained":true}',now()
      FROM generate_series(1,2) n`, [f.workspaceId,f.organizationId,batchId]);
    await pool.query(`INSERT INTO workspace_record_entities
      (workspace_id,org_id,entity_kind,entity_id,revision,schema_version,document)
      VALUES($1,$2,'metadata','legacy-2',2,1,'{"retained":true}')`, [f.workspaceId,f.organizationId]);
    const captures = async () => (await pool.query(`SELECT to_jsonb(request) AS value FROM workspace_checkpoint_requests request
      WHERE workspace_id=$1 ORDER BY created_at,id`, [f.workspaceId])).rows.map(row => row.value);
    const before = await captures();
    const objectKey = (await pool.query("SELECT object_key FROM workspace_blobs WHERE id=$1", [f.blobId])).rows[0].object_key as string;
    expect(await f.store.get(objectKey)).not.toBeNull();
    const request = await ownerDiscardDeleteRequest(pool, f), options = { databaseUrl: process.env.TEST_DATABASE_URL! };
    const plan = await manageCloudOwnerDiscardDelete(pool, request, options);
    const accepted = await manageCloudOwnerDiscardDelete(pool, request, { ...options, execute: true, approval: plan.approval });
    expect(await captures()).toEqual(before);
    const receipt = (await pool.query("SELECT source FROM cloud_workspace_owner_delete_receipts WHERE id=$1", [accepted.receiptId])).rows[0].source;
    expect(receipt.captures).toEqual(before);
    expect(receipt.history).toContainEqual(expect.objectContaining({ id: f.intentId, recovery: null }));
    expect((await pool.query(`SELECT state,original_request_id,current_request_id,proven_request_id,checkpoint_id
      FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1`, [f.intentId])).rows[0])
      .toEqual({ state: "discarded", original_request_id: null, current_request_id: null, proven_request_id: null, checkpoint_id: null });
    const dispositions = (await pool.query(`SELECT * FROM cloud_workspace_owner_delete_dispositions
      WHERE receipt_id=$1 ORDER BY lifecycle_intent_id`, [accepted.receiptId])).rows;
    expect(dispositions.map(row => row.lifecycle_intent_id).sort()).toEqual([f.intentId,f.stopId,accepted.deleteIntentId].sort());
    expect((await pool.query("SELECT cloud_final_save_proven($1) AS proven", [accepted.deleteIntentId])).rows[0].proven).toBe(false);

    const journal = new DatabaseCloudProviderOperationStore(pool, "boat", f.account), deletionId = randomUUID();
    let resource: CloudProviderResource | null = { resourceId: f.resourceId, workspaceId: f.workspaceId,
      organizationId: f.organizationId, generation: 1, state: "archived", target: "test-region", metadata: {} };
    const provider = { name: "boat", find: vi.fn(async () => resource ? [resource] : []), inspect: vi.fn(async () => resource),
      delete: vi.fn(async () => {
        await journal.beginDelete(f.resourceId);
        await journal.bindDeletion(f.resourceId, deletionId);
        await journal.completeDeletion(f.resourceId, deletionId);
        resource = null;
      }), verifyAbsence: vi.fn(async () => true), verifyManagedResourceOwnership: vi.fn(async () => true),
      create: vi.fn(), start: vi.fn(), stop: vi.fn(), archive: vi.fn() };
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const reconciler = new CloudWorkspaceReconciler({ pool, provider: provider as unknown as CloudWorkspaceProvider,
      workerId: "legacy-owner-delete", logger });
    const erasure = new CloudWorkspaceOperationsWorker(pool, f.blobs, { workerId: "legacy-owner-erasure", logger });
    const physicalDelete = vi.spyOn(f.store, "deleteAndFence");
    expect(await erasure.processDeletionOnce()).toBe(false);
    expect(await captures()).toEqual(before);
    await reconciler.runOnce(f.workspaceId);
    expect(provider.delete).toHaveBeenCalledExactlyOnceWith(f.resourceId);
    expect(provider.create).not.toHaveBeenCalled(); expect(provider.start).not.toHaveBeenCalled();
    expect((await journal.get(f.resourceId))?.deletedAt).toBeInstanceOf(Date);
    expect((await pool.query(`SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1`, [accepted.deleteIntentId])).rows[0].state).toBe("succeeded");
    expect((await pool.query("SELECT data_deleted_at FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0].data_deleted_at).toBeNull();
    expect(await captures()).toEqual(before);
    for (let pass=0; pass<6; pass++) await erasure.processDeletionOnce();
    expect(physicalDelete).toHaveBeenCalledExactlyOnceWith(objectKey);
    expect(await f.store.get(objectKey)).toBeNull();
    expect(logger.error.mock.calls).toEqual([]);
    expect((await pool.query("SELECT status,data_deleted_at IS NOT NULL AS erased FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0])
      .toEqual({ status: "deleted", erased: true });
    expect((await pool.query("SELECT state,error_code FROM workspace_deletion_jobs WHERE workspace_id=$1", [f.workspaceId])).rows[0])
      .toEqual({ state: "succeeded", error_code: null });
    for (const table of ["workspace_checkpoint_requests","workspace_checkpoints","workspace_blob_references",
      "workspace_content_heads","workspace_content_revisions","workspace_record_heads","workspace_record_batches",
      "workspace_record_events","workspace_record_entities","cloud_workspace_local_command_writers",
      "cloud_workspace_final_save_recoveries"]) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1`, [f.workspaceId])).rows[0].n, table).toBe(0);
    }
    expect((await pool.query("SELECT source FROM cloud_workspace_owner_delete_receipts WHERE id=$1", [accepted.receiptId])).rows[0].source).toEqual(receipt);
    expect((await pool.query("SELECT * FROM cloud_workspace_owner_delete_dispositions WHERE receipt_id=$1 ORDER BY lifecycle_intent_id", [accepted.receiptId])).rows)
      .toEqual(dispositions);
    expect(await manageCloudOwnerDiscardDelete(pool, request, { ...options, execute: true, approval: plan.approval }))
      .toMatchObject({ state: "unchanged", providerDeletion: "verified", dataErasure: "complete", deleteIntentId: accepted.deleteIntentId });
  }, 30_000);
});
