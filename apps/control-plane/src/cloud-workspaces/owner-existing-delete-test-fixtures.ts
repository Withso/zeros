import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { vi } from "vitest";
import { withSystemTx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { seedFinalSaveEngine } from "./final-save-test-fixtures.js";
import { DatabaseCloudWorkspaceBlobService, MemoryCloudWorkspaceObjectStore } from "./object-store.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";
import { requestCloudWorkspaceDeletion } from "./routes.js";
import { runFinalSaveRecovery } from "./final-save-service.js";
import { DatabaseCloudProviderOperationStore } from "./provider-operation-store.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";
import type { CloudProviderResource, CloudWorkspaceProvider } from "./provider.js";

/** Real ordinary Delete on a stopped generation with a dead, unsaved engine.
 * The older generation is positively retired; no current capture is invented. */
export async function seedExistingDelete(pool: pg.Pool) {
  const f = await seedReadyCloudWorkspace(pool), generation = 2;
  const resourceId = "bx_zst9k2m4", account = "fixture-existing-delete-account";
  await pool.query("UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1", [f.workspaceId]);
  await withSystemTx(pool, tx => retireCloudWorkspaceRuntimeAccess(tx, { ...f,reason:"generation_replacement_requested" }));
  await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='deleted',deletion_verified_at=now() WHERE workspace_id=$1", [f.workspaceId]);
  await pool.query(`INSERT INTO cloud_workspace_generations SELECT expanded.* FROM cloud_workspace_generations g,
    LATERAL jsonb_populate_record(NULL::cloud_workspace_generations,to_jsonb(g)||'{"generation":2}'::jsonb) expanded
    WHERE g.workspace_id=$1 AND g.generation=1`, [f.workspaceId]);
  await pool.query(`INSERT INTO cloud_workspace_provider_bindings(workspace_id,org_id,generation,provider,provider_resource_id,observed_state)
    VALUES($1,$2,2,'boat',$3,'running')`, [f.workspaceId,f.organizationId,resourceId]);
  const settingsId = randomUUID();
  await pool.query(`INSERT INTO workspace_settings_versions
    (id,workspace_id,generation,org_id,effective_document,provenance,source_versions,created_by)
    SELECT $2,workspace_id,2,org_id,effective_document,provenance,source_versions,created_by
    FROM workspace_settings_versions WHERE workspace_id=$1 AND generation=1`, [f.workspaceId,settingsId]);
  await pool.query(`INSERT INTO cloud_workspace_setup_specs SELECT expanded.* FROM cloud_workspace_setup_specs s,
    LATERAL jsonb_populate_record(NULL::cloud_workspace_setup_specs,to_jsonb(s)||jsonb_build_object('generation',2,'workspace_settings_version_id',$2::text)) expanded
    WHERE s.workspace_id=$1 AND s.generation=1`, [f.workspaceId,settingsId]);
  await pool.query("UPDATE cloud_workspaces SET current_generation=2 WHERE id=$1", [f.workspaceId]);
  const current = await withSystemTx(pool, tx => seedFinalSaveEngine(tx, { ...f,userId:f.userId,generation }));
  const scope = { ...f,...current,generation };
  const bootId = (await pool.query("SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [current.engineInstanceId])).rows[0].runtime_boot_id;
  const writerEpoch = randomUUID(), bindingId = randomUUID();
  await pool.query(`INSERT INTO cloud_workspace_local_command_writers
    (workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
    VALUES($1,$2,2,$3,$4,$5,$6,1)`, [f.workspaceId,f.organizationId,current.engineInstanceId,bootId,writerEpoch,f.userId]);
  await pool.query(`INSERT INTO cloud_agent_boot_bindings
    (id,workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch,credentials_initialized,initial_adoptions)
    VALUES($1,$2,$3,2,$4,$5,$6,$7,1,true,'[{"provider":"claude","status":"missing"},{"provider":"codex","status":"missing"},{"provider":"cursor","status":"missing"}]')`,
  [bindingId,f.workspaceId,f.organizationId,current.engineInstanceId,bootId,writerEpoch,f.userId]);
  await pool.query("UPDATE cloud_workspace_local_command_writers SET state='active',activated_at=now() WHERE writer_epoch=$1", [writerEpoch]);
  await pool.query("UPDATE cloud_workspaces SET agent_command_mode='boot-owner-v1',agent_boot_id=$2 WHERE id=$1", [f.workspaceId,bindingId]);
  await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1,final_save_version=1 WHERE id=$1", [current.engineInstanceId]);
  const store = new MemoryCloudWorkspaceObjectStore();
  const blobs = new DatabaseCloudWorkspaceBlobService({ pool,objectStore:store,
    encryptionKeyV1:randomBytes(32).toString("base64url"),workosEnabled:false });
  const blob = await blobs.put({ ...scope,bytes:Buffer.from("synthetic retained existing Delete data") });
  const checkpointId = randomUUID(), batchId = randomUUID(), leaseId = randomUUID();
  await pool.query(`INSERT INTO workspace_content_heads(workspace_id,org_id,current_revision,durable_revision) VALUES($1,$2,1,1)`, [f.workspaceId,f.organizationId]);
  await pool.query(`INSERT INTO workspace_content_revisions(workspace_id,org_id,revision,parent_revision,authority_epoch,
    generation,engine_instance_id,idempotency_key,request_sha256,changed_entry_count)
    VALUES($1,$2,1,0,1,2,$3,'existing-delete-content',decode(repeat('a',64),'hex'),0)`, [f.workspaceId,f.organizationId,current.engineInstanceId]);
  await pool.query(`INSERT INTO workspace_record_heads(workspace_id,org_id,current_revision,last_durable_at) VALUES($1,$2,1,now())`, [f.workspaceId,f.organizationId]);
  await pool.query(`INSERT INTO workspace_record_batches(id,workspace_id,org_id,generation,engine_instance_id,authority_epoch,
    idempotency_key,request_sha256,first_revision,last_revision,event_count)
    VALUES($1,$2,$3,2,$4,1,'existing-delete-record',decode(repeat('b',64),'hex'),1,1,1)`, [batchId,f.workspaceId,f.organizationId,current.engineInstanceId]);
  await pool.query(`INSERT INTO workspace_record_events(workspace_id,org_id,revision,batch_id,entity_kind,entity_id,operation,document,occurred_at)
    VALUES($1,$2,1,$3,'metadata','existing-delete','upsert','{"retained":true}',now())`, [f.workspaceId,f.organizationId,batchId]);
  await pool.query(`INSERT INTO workspace_record_entities(workspace_id,org_id,entity_kind,entity_id,revision,schema_version,document)
    VALUES($1,$2,'metadata','existing-delete',1,1,'{"retained":true}')`, [f.workspaceId,f.organizationId]);
  await pool.query(`INSERT INTO workspace_checkpoints(id,workspace_id,org_id,idempotency_key,request_sha256,content_revision,
    record_revision,authority_epoch,generation,reason,manifest_blob_id,inclusion_policy,file_count,total_bytes,state,integrity_sha256,durable_at)
    VALUES($1,$2,$3,'existing-delete-manual',decode(repeat('c',64),'hex'),1,1,1,2,'manual',$4,'{}',0,0,'durable',
      decode(repeat('c',64),'hex'),clock_timestamp()-interval '1 day')`, [checkpointId,f.workspaceId,f.organizationId,blob.id]);
  await pool.query("UPDATE workspace_content_heads SET current_checkpoint_id=$2 WHERE workspace_id=$1", [f.workspaceId,checkpointId]);
  await pool.query(`INSERT INTO workspace_checkpoint_requests(workspace_id,org_id,generation,reason,state,idempotency_key,checkpoint_id,deadline_at,completed_at)
    VALUES($1,$2,2,'manual','succeeded','existing-delete-prior-manual',$3,now()+interval '1 minute',now())`, [f.workspaceId,f.organizationId,checkpointId]);
  await pool.query(`INSERT INTO workspace_blob_references(blob_id,org_id,workspace_id,reference_kind,reference_id)
    VALUES($1,$2,$3,'checkpoint_manifest',$4)`, [blob.id,f.organizationId,f.workspaceId,checkpointId]);
  await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,org_id,generation,requested_by,operation,state,completed_at,idempotency_key,request_sha256)
    VALUES($1::uuid,$2,$3,2,$4,'wake','succeeded',now(),$1::text,digest($1::text,'sha256'))`, [leaseId,f.workspaceId,f.organizationId,f.userId]);
  await pool.query(`INSERT INTO managed_compute_allocation_leases(id,workspace_id,org_id,generation,billing_epoch,user_id,lifecycle_intent_id,
    provider,provider_resource_id,policy_id,seconds_per_dollar,weight_numerator,weight_denominator,ttl_seconds,state,funded_until,
    provider_expires_at,settled_at,stopped_observed_at,requested_at)
    VALUES($1,$2,$3,2,1,$4,$1,'boat',$5,'fixture',1000,1,1,600,'settled',now()+interval '10 minutes',now()+interval '9 minutes',now(),now(),now()-interval '1 minute')`,
  [leaseId,f.workspaceId,f.organizationId,f.userId,resourceId]);
  await pool.query(`INSERT INTO cloud_workspace_provider_operations(provider,account_scope,workspace_id,generation,org_id,idempotency_key,
    request_sha256,create_attempts_tracked,resource_id) VALUES('boat',$1,$2,2,$3,$4,$5,true,$6)`,
  [account,f.workspaceId,f.organizationId,randomUUID(),"a".repeat(64),resourceId]);
  await pool.query("UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1", [f.workspaceId]);
  await withSystemTx(pool, tx => retireCloudWorkspaceRuntimeAccess(tx, { ...f,reason:"engine_unavailable" }));
  await pool.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped',last_error_code='recovery_needed' WHERE id=$1", [f.workspaceId]);
  const deletion = await withSystemTx(pool, tx => requestCloudWorkspaceDeletion(tx, { ...f,actorUserId:f.userId,idempotencyKey:`operator-delete:${randomUUID()}` }));
  const deleteId = deletion.intent.id;
  await pool.query("UPDATE cloud_workspace_final_save_recoveries SET next_attempt_at=clock_timestamp() WHERE lifecycle_intent_id=$1", [deleteId]);
  await runFinalSaveRecovery(pool, f.workspaceId, false);
  await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [f.userId]);
  const slug = (await pool.query("SELECT slug FROM organizations WHERE id=$1", [f.organizationId])).rows[0].slug as string;
  const request = { version:1 as const,mode:"existing-delete" as const,channel:"development" as const,operationId:randomUUID(),
    organizationId:f.organizationId,expectedOrganizationSlug:slug,workspaceId:f.workspaceId,ownerUserId:f.userId,operatorUserId:f.userId,
    sourceGeneration:generation,deleteIntentId:deleteId,recoveryIntentId:deleteId,engineInstanceId:current.engineInstanceId,
    allocationLeaseId:leaseId,providerResourceId:resourceId,providerAccountScope:account,ownerAcknowledgedCompleteDataLoss:true as const,
    ownerApprovalReference:"Synthetic owner approves complete data loss on this existing Delete",
    reason:"Synthetic stopped workspace cannot produce a final capture" };
  return { ...scope,request,deleteId,leaseId,resourceId,account,store,blobs,blobId:blob.id,checkpointId,writerEpoch,bindingId };
}

export function existingDeleteWorkers(pool: pg.Pool, f: Pick<Awaited<ReturnType<typeof seedExistingDelete>>,
  "account" | "resourceId" | "workspaceId" | "organizationId" | "generation" | "blobs">) {
  const journal = new DatabaseCloudProviderOperationStore(pool,"boat",f.account), providerDeleteId = randomUUID();
  let resource: CloudProviderResource | null = { resourceId:f.resourceId,workspaceId:f.workspaceId,
    generation:f.generation,state:"stopped",target:"test-region",metadata:{} };
  const provider = { name:"boat",find:vi.fn(async () => resource ? [resource] : []),inspect:vi.fn(async () => resource),
    delete:vi.fn(async () => {
      await journal.beginDelete(f.resourceId); await journal.bindDeletion(f.resourceId,providerDeleteId);
      await journal.completeDeletion(f.resourceId,providerDeleteId); resource=null;
    }),verifyAbsence:vi.fn(async () => true),verifyManagedResourceOwnership:vi.fn(async () => true),
    create:vi.fn(),start:vi.fn(),stop:vi.fn(),archive:vi.fn() };
  const logger = { error:vi.fn(),warn:vi.fn(),info:vi.fn() };
  return { provider,logger,journal,
    reconciler:new CloudWorkspaceReconciler({ pool,provider:provider as unknown as CloudWorkspaceProvider,workerId:"existing-owner-delete",logger }),
    erasure:new CloudWorkspaceOperationsWorker(pool,f.blobs,{ workerId:"existing-owner-erasure",logger }) };
}
