import { readFile, readdir } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx } from "../db.js";
import type { CloudOwnerDiscardDeleteRequest } from "../cloud-owner-discard-delete-contract.js";
import { seedReadyCloudWorkspace, seedSupportedCloudWorkspaceGeneration } from "./test-fixtures.js";
import { seedFinalSaveEngine } from "./final-save-test-fixtures.js";
import { DatabaseCloudWorkspaceBlobService, MemoryCloudWorkspaceObjectStore } from "./object-store.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";
import { requestManagedComputeStop } from "./compute-credit-stop.js";
import { CloudWorkspaceCheckpointRequestWorker } from "./checkpoint-requests.js";
import { runFinalSaveRecovery } from "./final-save-service.js";

const directory = new URL("../../migrations/", import.meta.url);
const first = "0171_cloud_final_save_recovery.sql";

async function migrate(pool: pg.Pool, before: boolean) {
  const client = await pool.connect();
  try {
    for (const file of (await readdir(directory)).filter(name => /^\d{4}_.+\.sql$/.test(name) && (before ? name < first : name >= first)).sort()) {
      await client.query("BEGIN");
      try { await client.query(await readFile(new URL(file, directory), "utf8")); await client.query("COMMIT"); }
      catch (error) { await client.query("ROLLBACK"); throw error; }
    }
  } finally { client.release(); }
}

/** Synthetic values with the observed live generations and row distribution.
 * Legacy captures are written on the actual pre-0171 schema, then migrated.
 * No trigger disabling, fabricated recovery flags, or live data is used. */
export async function seedOwnerDeleteHistoricalCaptures(pool: pg.Pool) {
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
    CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());`);
  await migrate(pool, true);
  const f = await seedReadyCloudWorkspace(pool);
  const scope = { workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 2 };
  const store = new MemoryCloudWorkspaceObjectStore();
  const blobs = new DatabaseCloudWorkspaceBlobService({ pool, objectStore: store,
    encryptionKeyV1: randomBytes(32).toString("base64url"), workosEnabled: false });
  const blob = await blobs.put({ ...f, generation: 1, bytes: Buffer.from("synthetic retained owner history") });
  await pool.query(`INSERT INTO workspace_content_heads(workspace_id,org_id,current_revision,durable_revision,last_durable_at)
    VALUES($1,$2,12,12,clock_timestamp())`, [f.workspaceId,f.organizationId]);
  await pool.query(`INSERT INTO workspace_record_heads(workspace_id,org_id,current_revision,last_durable_at)
    VALUES($1,$2,2,clock_timestamp())`, [f.workspaceId,f.organizationId]);
  const batchId = randomUUID();
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
  await pool.query(`INSERT INTO workspace_content_revisions(workspace_id,org_id,revision,parent_revision,authority_epoch,
    generation,engine_instance_id,idempotency_key,request_sha256,changed_entry_count)
    SELECT $1,$2,n,n-1,1,1,$3,'legacy.'||n::text,digest(n::text,'sha256'),0 FROM generate_series(1,12) n`,
  [f.workspaceId,f.organizationId,f.engineInstanceId]);
  const savedIntentId = randomUUID(), savedRequestId = randomUUID(), savedCheckpointId = randomUUID();
  await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
    (id,workspace_id,org_id,generation,requested_by,operation,state,completed_at,idempotency_key,request_sha256,affects_workspace)
    VALUES($1::uuid,$2,$3,1,$4,'stop','succeeded',clock_timestamp(),$1::text,digest($1::text,'sha256'),false)`,
  [savedIntentId,f.workspaceId,f.organizationId,f.userId]);
  await pool.query(`INSERT INTO workspace_checkpoints
    (id,workspace_id,org_id,idempotency_key,request_sha256,content_revision,record_revision,authority_epoch,generation,
      reason,manifest_blob_id,inclusion_policy,file_count,total_bytes,state,integrity_sha256,durable_at)
    VALUES($1::uuid,$2,$3,$1::text,digest($1::text,'sha256'),12,2,1,1,'before_stop',$4,'{}',0,0,'durable',digest($1::text,'sha256'),clock_timestamp())`,
  [savedCheckpointId,f.workspaceId,f.organizationId,blob.id]);
  await pool.query(`INSERT INTO workspace_checkpoint_requests
    (id,workspace_id,org_id,generation,requested_by,lifecycle_intent_id,reason,idempotency_key,deadline_at)
    VALUES($1::uuid,$2,$3,1,$4,$5,'before_stop',$1::text,clock_timestamp()+interval '5 minutes')`,
  [savedRequestId,f.workspaceId,f.organizationId,f.userId,savedIntentId]);
  // Exercise the deployed old completion write before the final-save columns
  // or recovery/link/retirement triggers exist.
  await withSystemTx(pool, async tx => {
    await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
    await tx.query("UPDATE workspace_checkpoint_requests SET state='succeeded',checkpoint_id=$2,completed_at=clock_timestamp() WHERE id=$1",
      [savedRequestId,savedCheckpointId]);
  });
  await pool.query(`INSERT INTO workspace_blob_references(blob_id,org_id,workspace_id,reference_kind,reference_id)
    VALUES($1,$2,$3,'checkpoint_manifest',$4)`, [blob.id,f.organizationId,f.workspaceId,savedCheckpointId]);
  await withSystemTx(pool, async tx => {
    await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [f.organizationId]);
    await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
    await retireCloudWorkspaceRuntimeAccess(tx, { ...scope, generation: 1, reason: "generation_replaced" });
    const generation = await seedSupportedCloudWorkspaceGeneration(tx, { ...scope, ownerUserId: f.userId });
    const settingsId = randomUUID();
    await tx.query(`INSERT INTO workspace_settings_versions
      (id,workspace_id,generation,org_id,effective_document,provenance,source_versions,created_by)
      VALUES($1,$2,2,$3,'{"schemaVersion":1,"values":{}}','{}',$4::jsonb,$5)`,
    [settingsId,f.workspaceId,f.organizationId,JSON.stringify({fixture:1,computerEnvironment:{configId:generation.source.configId,bindings:[]}}),f.userId]);
    await tx.query(`INSERT INTO cloud_workspace_setup_specs
      (workspace_id,generation,org_id,repository_forge,repository_owner,repository_name,repository_revision,
        settings_snapshot,settings_snapshot_sha256,workspace_settings_version_id)
      SELECT workspace_id,2,org_id,repository_forge,repository_owner,repository_name,repository_revision,
        settings_snapshot,settings_snapshot_sha256,$2 FROM cloud_workspace_setup_specs WHERE workspace_id=$1 AND generation=1`,
    [f.workspaceId,settingsId]);
    await tx.query("UPDATE cloud_workspaces SET current_generation=2,authority_epoch=authority_epoch+1 WHERE id=$1", [f.workspaceId]);
  });
  await pool.query(`UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=clock_timestamp(),
    lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1 AND generation=1`, [f.workspaceId]);
  await pool.query(`UPDATE cloud_workspace_provider_bindings SET observed_state='deleted',deletion_verified_at=clock_timestamp()
    WHERE workspace_id=$1 AND generation=1`, [f.workspaceId]);
  const resourceId = "bx_zst7k2m5", account = "owner-delete-capture-fixture";
  await pool.query(`INSERT INTO cloud_workspace_provider_bindings
    (workspace_id,org_id,generation,provider,provider_resource_id,observed_state,last_observed_at)
    VALUES($1,$2,2,'boat',$3,'archived',clock_timestamp())`, [f.workspaceId,f.organizationId,resourceId]);
  const current = await withSystemTx(pool, tx => seedFinalSaveEngine(tx, { ...scope, userId: f.userId }));
  await pool.query(`UPDATE cloud_workspace_engine_instances SET registered_at=clock_timestamp()-interval '10 minutes',
    last_heartbeat_at=clock_timestamp()-interval '2 minutes' WHERE id=$1`, [current.engineInstanceId]);
  await pool.query(`UPDATE cloud_workspace_setup_runs SET state='failed',error_code='setup_checkpoint_restore_unavailable',
    completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1 AND generation=2`, [f.workspaceId]);
  await withSystemTx(pool, async tx => {
    await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
    await retireCloudWorkspaceRuntimeAccess(tx, { ...scope, reason: "setup_failed" });
  });
  await pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=clock_timestamp()-interval '30 seconds' WHERE id=$1", [current.engineInstanceId]);
  // Four retained, unsealed writers are evidence of past work, not absence or
  // invented successful final saves. Distinct boot scopes retain their rows.
  await pool.query(`INSERT INTO cloud_workspace_local_command_writers
    (workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch,state,activated_at,retired_at)
    SELECT $1,$2,1,$3,gen_random_uuid(),gen_random_uuid(),$4,1,'retired',clock_timestamp()-interval '1 minute',clock_timestamp()
    FROM generate_series(1,4)`, [f.workspaceId,f.organizationId,f.engineInstanceId,f.userId]);
  const cancelledIntentIds: string[] = [], cancelledRequestIds: string[] = [];
  for (let index=0; index<38; index++) {
    const intentId = randomUUID(), requestId = randomUUID();
    cancelledIntentIds.push(intentId); cancelledRequestIds.push(requestId);
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,requested_by,operation,state,completed_at,idempotency_key,request_sha256,affects_workspace)
      VALUES($1::uuid,$2,$3,2,$4,'stop','superseded',clock_timestamp(),$1::text,digest($1::text,'sha256'),false)`,
    [intentId,f.workspaceId,f.organizationId,f.userId]);
    await pool.query(`INSERT INTO workspace_checkpoint_requests
      (id,workspace_id,org_id,generation,requested_by,lifecycle_intent_id,reason,state,idempotency_key,created_at,deadline_at,completed_at)
      VALUES($1::uuid,$2,$3,2,$4,$5,'before_stop','cancelled',$1::text,
        clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '5 minutes',clock_timestamp()-interval '4 minutes')`,
    [requestId,f.workspaceId,f.organizationId,f.userId,intentId]);
  }
  const fundingIntentId = randomUUID();
  await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
    (id,workspace_id,org_id,generation,requested_by,operation,state,completed_at,idempotency_key,request_sha256,affects_workspace)
    VALUES($1::uuid,$2,$3,2,$4,'wake','succeeded',clock_timestamp(),$1::text,digest($1::text,'sha256'),true)`,
  [fundingIntentId,f.workspaceId,f.organizationId,f.userId]);
  for (const [operation,count,generation] of [["stop",4,2],["wake",23,2],["create",2,1],["delete",1,1]] as const) {
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,requested_by,operation,state,completed_at,idempotency_key,request_sha256,affects_workspace)
      SELECT id,$1,$2,$3,$4,$5::cloud_workspace_operation,'succeeded',clock_timestamp(),id::text,digest(id::text,'sha256'),$5 IN ('wake','create')
      FROM (SELECT gen_random_uuid() AS id FROM generate_series(1,$6::integer)) ids`,
    [f.workspaceId,f.organizationId,generation,f.userId,operation,count]);
  }
  const periodicCheckpointId = randomUUID();
  await pool.query(`INSERT INTO workspace_checkpoints
    (id,workspace_id,org_id,idempotency_key,request_sha256,content_revision,record_revision,authority_epoch,generation,
      reason,manifest_blob_id,inclusion_policy,file_count,total_bytes,state,integrity_sha256,durable_at)
    VALUES($1::uuid,$2,$3,$1::text,digest($1::text,'sha256'),12,2,2,2,'periodic',$4,'{}',0,0,'durable',digest($1::text,'sha256'),clock_timestamp())`,
  [periodicCheckpointId,f.workspaceId,f.organizationId,blob.id]);
  await pool.query(`INSERT INTO workspace_blob_references(blob_id,org_id,workspace_id,reference_kind,reference_id)
    VALUES($1,$2,$3,'checkpoint_manifest',$4)`, [blob.id,f.organizationId,f.workspaceId,periodicCheckpointId]);
  await pool.query(`INSERT INTO workspace_blob_references(blob_id,org_id,workspace_id,reference_kind,reference_id)
    SELECT $1,$2,$3,'file_entry','synthetic-file.'||n::text FROM generate_series(1,760) n`, [blob.id,f.organizationId,f.workspaceId]);
  await pool.query("UPDATE workspace_blobs SET reference_count=762 WHERE id=$1", [blob.id]);
  await pool.query("UPDATE workspace_content_heads SET current_checkpoint_id=$2 WHERE workspace_id=$1", [f.workspaceId,periodicCheckpointId]);
  await pool.query(`INSERT INTO managed_compute_allocation_leases
    (id,workspace_id,org_id,generation,billing_epoch,user_id,lifecycle_intent_id,provider,provider_resource_id,policy_id,
      seconds_per_dollar,weight_numerator,weight_denominator,ttl_seconds,state,funded_until,provider_expires_at)
    VALUES($1,$2,$3,2,1,$4,$1,'boat',$5,'fixture',1000,1,1,600,'active',clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '9 minutes')`,
  [fundingIntentId,f.workspaceId,f.organizationId,f.userId,resourceId]);
  await pool.query(`INSERT INTO cloud_workspace_provider_operations
    (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,create_attempts_tracked,resource_id)
    VALUES('boat',$1,$2,2,$3,$4,$5,true,$6)`, [account,f.workspaceId,f.organizationId,randomUUID(),"a".repeat(64),resourceId]);
  await migrate(pool, false);
  await requestManagedComputeStop(pool, { leaseId: fundingIntentId, reason: "engine_unavailable" });
  const capture = (await pool.query(`SELECT request.id,request.lifecycle_intent_id FROM workspace_checkpoint_requests request
    JOIN managed_compute_allocation_leases lease ON lease.stop_intent_id=request.lifecycle_intent_id WHERE lease.id=$1`, [fundingIntentId])).rows[0];
  await pool.query(`UPDATE workspace_checkpoint_requests SET created_at=clock_timestamp()-interval '6 minutes',
    deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [capture.id]);
  if (await new CloudWorkspaceCheckpointRequestWorker(pool).expireOnce() !== 1) throw new Error("Live-shape fixture requires one actual expired capture");
  await pool.query("UPDATE cloud_workspace_final_save_recoveries SET next_attempt_at=clock_timestamp() WHERE lifecycle_intent_id=$1", [capture.lifecycle_intent_id]);
  if (await runFinalSaveRecovery(pool,f.workspaceId,false) !== 1) throw new Error("Live-shape fixture requires one actual blocked recovery");
  await pool.query(`UPDATE managed_compute_allocation_leases SET state='settled',settled_at=clock_timestamp(),
    stopped_observed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`, [fundingIntentId]);
  await pool.query("UPDATE cloud_workspaces SET status='stopping',desired_state='stopped' WHERE id=$1", [f.workspaceId]);
  await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [f.userId]);
  const slug = (await pool.query("SELECT slug FROM organizations WHERE id=$1", [f.organizationId])).rows[0].slug;
  const request: CloudOwnerDiscardDeleteRequest = { version:1, channel:"development",operationId:randomUUID(),organizationId:f.organizationId,
    expectedOrganizationSlug:slug,workspaceId:f.workspaceId,ownerUserId:f.userId,operatorUserId:f.userId,sourceGeneration:2,
    stopIntentId:capture.lifecycle_intent_id,requestId:capture.id,engineInstanceId:current.engineInstanceId,allocationLeaseId:fundingIntentId,
    providerResourceId:resourceId,providerAccountScope:account,ownerAcknowledgedCompleteDataLoss:true,
    ownerApprovalReference:"Synthetic approval for the observed complete-loss shape",reason:"Synthetic owner deletion of retained pre-0171 capture history" };
  return { ...f,...scope,current,request,resourceId,account,blobs,store,blobId:blob.id,cancelledIntentIds,cancelledRequestIds,savedRequestId,
    savedCheckpointId,periodicCheckpointId,stopId:capture.lifecycle_intent_id as string,requestId:capture.id as string };
}
