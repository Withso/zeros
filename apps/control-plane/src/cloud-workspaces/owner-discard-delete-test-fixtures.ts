import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { seedFinalSaveEngine } from "./final-save-test-fixtures.js";
import { DatabaseCloudWorkspaceBlobService, MemoryCloudWorkspaceObjectStore } from "./object-store.js";
import { requestManagedComputeStop } from "./compute-credit-stop.js";
import { CloudWorkspaceCheckpointRequestWorker, deliverWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import { DatabaseCloudFinalSaveService, runFinalSaveRecovery } from "./final-save-service.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";
import { stopUnavailableCloudEngine } from "./engine-health.js";
import type { CloudOwnerDiscardDeleteRequest } from "../cloud-owner-discard-delete-contract.js";
const resourceId = "bx_zst7k2m4", account = "fixture-owner-delete-account";

export async function seedOwnerDiscardDelete(pool: pg.Pool, options: { crashedReady?: boolean; engineFailureStop?: boolean;
  readyFixture?: Awaited<ReturnType<typeof seedReadyCloudWorkspace>> } = {}) {
    const crashedReady = options.crashedReady || options.engineFailureStop;
    const f = options.readyFixture ?? await seedReadyCloudWorkspace(pool);
    const scope = { workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1 };
    const store = new MemoryCloudWorkspaceObjectStore();
    const blobs = new DatabaseCloudWorkspaceBlobService({ pool, objectStore: store,
      encryptionKeyV1: randomBytes(32).toString("base64url"), workosEnabled: false });
    const blob = await blobs.put({ ...scope, engineInstanceId: f.engineInstanceId, heartbeatToken: f.heartbeatToken,
      bytes: Buffer.from("synthetic prior durable manifest") });
    const checkpointId = randomUUID(), wakeId = randomUUID();
    await pool.query(`INSERT INTO workspace_content_heads(workspace_id,org_id,current_revision,durable_revision,last_durable_at)
      VALUES($1,$2,12,12,clock_timestamp()-interval '5 days')`, [f.workspaceId, f.organizationId]);
    await pool.query(`INSERT INTO workspace_content_revisions(workspace_id,org_id,revision,parent_revision,authority_epoch,
      generation,engine_instance_id,idempotency_key,request_sha256,changed_entry_count)
      SELECT $1,$2,n,n-1,1,1,$3,'preserved.'||n::text,digest(n::text,'sha256'),0 FROM generate_series(1,12) AS n`,
    [f.workspaceId, f.organizationId, f.engineInstanceId]);
    await pool.query(`INSERT INTO workspace_record_heads(workspace_id,org_id,current_revision,last_durable_at)
      VALUES($1,$2,2,clock_timestamp()-interval '5 days')`, [f.workspaceId, f.organizationId]);
    await pool.query(`INSERT INTO workspace_checkpoints(id,workspace_id,org_id,idempotency_key,request_sha256,content_revision,
      record_revision,authority_epoch,generation,reason,manifest_blob_id,inclusion_policy,file_count,total_bytes,state,integrity_sha256,durable_at)
      VALUES($1::uuid,$2,$3,$1::text,decode(repeat('c',64),'hex'),12,2,1,1,'periodic',$4,'{}',0,0,
        'durable',decode(repeat('c',64),'hex'),clock_timestamp()-interval '5 days')`, [checkpointId, f.workspaceId, f.organizationId, blob.id]);
    await pool.query(`INSERT INTO workspace_blob_references(blob_id,org_id,workspace_id,reference_kind,reference_id)
      VALUES($1,$2,$3,'checkpoint_manifest',$4)`, [blob.id,f.organizationId,f.workspaceId,checkpointId]);
    await pool.query("UPDATE workspace_content_heads SET current_checkpoint_id=$2 WHERE workspace_id=$1", [f.workspaceId, checkpointId]);
    await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id=$2 WHERE workspace_id=$1", [f.workspaceId, resourceId]);
    await pool.query(`UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL
      WHERE workspace_id=$1`, [f.workspaceId]);
    const current = await withSystemTx(pool, async tx => {
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [f.organizationId]);
      await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
      await retireCloudWorkspaceRuntimeAccess(tx, { ...scope, reason: "generation_replacement_requested" });
      return seedFinalSaveEngine(tx, { ...scope, userId: f.userId, setupAttempt: 2 });
    });
    // Seed a genuinely older registration before final-save admission freezes
    // its identity. Expired-ready controls must still satisfy the engine's
    // lease-after-registration/heartbeat invariant.
    await pool.query(`UPDATE cloud_workspace_engine_instances SET registered_at=clock_timestamp()-interval '10 minutes',
      last_heartbeat_at=clock_timestamp()-interval '2 minutes' WHERE id=$1`, [current.engineInstanceId]);
    const writerEpoch = crashedReady ? randomUUID() : null;
    if (writerEpoch) {
      const bootId = (await pool.query("SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [current.engineInstanceId])).rows[0].runtime_boot_id;
      const bindingId = randomUUID();
      await pool.query(`INSERT INTO cloud_workspace_local_command_writers
        (workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
        VALUES($1,$2,1,$3,$4,$5,$6,1)`, [f.workspaceId,f.organizationId,current.engineInstanceId,bootId,writerEpoch,f.userId]);
      await pool.query(`INSERT INTO cloud_agent_boot_bindings
        (id,workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch,credentials_initialized,initial_adoptions)
        VALUES($1,$2,$3,1,$4,$5,$6,$7,1,true,'[{"provider":"claude","status":"missing"},{"provider":"codex","status":"missing"},{"provider":"cursor","status":"missing"}]')`,
      [bindingId,f.workspaceId,f.organizationId,current.engineInstanceId,bootId,writerEpoch,f.userId]);
      await pool.query("UPDATE cloud_workspace_local_command_writers SET state='active',activated_at=now() WHERE writer_epoch=$1", [writerEpoch]);
      await pool.query("UPDATE cloud_workspaces SET agent_command_mode='boot-owner-v1',agent_boot_id=$2 WHERE id=$1", [f.workspaceId,bindingId]);
      await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1,final_save_version=1 WHERE id=$1", [current.engineInstanceId]);
    }
    await pool.query(`UPDATE cloud_workspace_setup_runs SET state=$2,error_code=$3,
      completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1 AND attempt=2`,
    [f.workspaceId, crashedReady ? "succeeded" : "failed", crashedReady ? null : "setup_checkpoint_restore_unavailable"]);
    // The real failed-setup path retires the consumed endpoint grants as well
    // as the engine. A failed setup fixture must retain that authority fence.
    const retire = async () => {
      await withSystemTx(pool, async tx => {
        await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [f.organizationId]);
        await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
        await retireCloudWorkspaceRuntimeAccess(tx, { ...scope, reason: crashedReady ? "engine_unavailable" : "setup_failed" });
      });
      await pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=clock_timestamp()-interval '30 seconds' WHERE id=$1", [current.engineInstanceId]);
    };
    if (!crashedReady) await retire();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,org_id,generation,requested_by,operation,
      state,completed_at,idempotency_key,request_sha256) VALUES($1::uuid,$2,$3,1,$4,'wake','succeeded',now(),$1::text,digest($1::text,'sha256'))`,
    [wakeId, f.workspaceId, f.organizationId, f.userId]);
    await pool.query(`INSERT INTO managed_compute_allocation_leases(id,workspace_id,org_id,generation,billing_epoch,user_id,
      lifecycle_intent_id,provider,provider_resource_id,policy_id,seconds_per_dollar,weight_numerator,weight_denominator,ttl_seconds,
      state,funded_until,provider_expires_at) VALUES($1,$2,$3,1,1,$4,$1,'boat',$5,'fixture',1000,1,1,600,'active',
        clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '9 minutes')`, [wakeId, f.workspaceId, f.organizationId, f.userId, resourceId]);
    await pool.query(`INSERT INTO cloud_workspace_provider_operations(provider,account_scope,workspace_id,generation,org_id,
      idempotency_key,request_sha256,create_attempts_tracked,resource_id) VALUES('boat',$1,$2,1,$3,$4,$5,true,$6)`,
    [account, f.workspaceId, f.organizationId, randomUUID(), "a".repeat(64), resourceId]);
    if (options.engineFailureStop) {
      await pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=clock_timestamp()-interval '30 seconds' WHERE id=$1", [current.engineInstanceId]);
      await pool.query("UPDATE cloud_workspaces SET status='ready',desired_state='running' WHERE id=$1", [f.workspaceId]);
      if (!await stopUnavailableCloudEngine(pool, "boat", f.workspaceId)) throw new Error("Fixture requires the real unavailable-engine Stop");
    }
    // The compute worker adopts the engine-health producer's exact Stop and
    // binds the allocation; it must not replace it with a compute-stop key.
    await requestManagedComputeStop(pool, { leaseId: wakeId, reason: "engine_unavailable" });
    const capture = (await pool.query(`SELECT request.id,request.lifecycle_intent_id FROM workspace_checkpoint_requests request
      JOIN managed_compute_allocation_leases lease ON lease.stop_intent_id=request.lifecycle_intent_id
      WHERE request.workspace_id=$1 AND lease.id=$2`, [f.workspaceId,wakeId])).rows[0];
    if (crashedReady && !options.engineFailureStop) {
      const directive = await withSystemTx(pool, tx => deliverWorkspaceCheckpointRequest(tx, { ...current, finalSaveVersion: 1 }));
      if (!directive?.finalSave) throw new Error("Fixture requires the real negotiated delivered capture");
      await new DatabaseCloudFinalSaveService(pool, false).report({ version: 1, kind: "retry", ...scope,
        engineInstanceId: current.engineInstanceId, token: current.heartbeatToken, recoveryId: capture.lifecycle_intent_id,
        requestId: capture.id, attemptOrdinal: 0, sourceSha256: directive.finalSave.sourceSha256,
        custodyId: randomUUID(), commit: null, failure: "capture_failed" });
      await retire();
    }
    await pool.query(`UPDATE workspace_checkpoint_requests SET created_at=clock_timestamp()-interval '6 minutes',
      deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [capture.id]);
    if (await new CloudWorkspaceCheckpointRequestWorker(pool).expireOnce() !== 1) throw new Error("Fixture requires one expired final capture");
    await pool.query("UPDATE cloud_workspace_final_save_recoveries SET next_attempt_at=clock_timestamp() WHERE lifecycle_intent_id=$1", [capture.lifecycle_intent_id]);
    if (await runFinalSaveRecovery(pool, f.workspaceId, false) !== 1) throw new Error("Fixture requires one blocked recovery");
    await pool.query(`UPDATE cloud_workspace_provider_bindings SET observed_state='archived',last_observed_at=clock_timestamp(),
      observed_metadata='{"snapshotAvailable":true,"lastSnapshotStatus":"completed"}'::jsonb WHERE workspace_id=$1`, [f.workspaceId]);
    await pool.query(`UPDATE managed_compute_allocation_leases SET state='settled',settled_at=clock_timestamp(),
      stopped_observed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`, [wakeId]);
    await pool.query("UPDATE cloud_workspaces SET status='stopping',desired_state='stopped' WHERE id=$1", [f.workspaceId]);
    await pool.query(`UPDATE cloud_workspace_lifecycle_intents SET next_attempt_at=clock_timestamp()-interval '16 minutes',
      updated_at=clock_timestamp()-interval '16 minutes' WHERE id=$1`, [capture.lifecycle_intent_id]);
    await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [f.userId]);
    return { ...f, ...scope, current, checkpointId, blobId: blob.id, wakeId, blobs, store, resourceId, account, writerEpoch,
      stopId: capture.lifecycle_intent_id as string, requestId: capture.id as string };
  }

export async function ownerDiscardDeleteRequest(pool: pg.Pool, f: Awaited<ReturnType<typeof seedOwnerDiscardDelete>>): Promise<CloudOwnerDiscardDeleteRequest> {
  const slug = (await pool.query("SELECT slug FROM organizations WHERE id=$1", [f.organizationId])).rows[0].slug as string;
  return { version: 1, channel: "development", operationId: randomUUID(), organizationId: f.organizationId,
    expectedOrganizationSlug: slug, workspaceId: f.workspaceId, ownerUserId: f.userId, operatorUserId: f.userId,
    sourceGeneration: 1, stopIntentId: f.stopId, requestId: f.requestId, engineInstanceId: f.current.engineInstanceId,
    allocationLeaseId: f.wakeId, providerResourceId: f.resourceId, providerAccountScope: f.account,
    ownerAcknowledgedCompleteDataLoss: true, ownerApprovalReference: "synthetic owner approval for complete deletion",
    reason: "Synthetic irrecoverable final save; delete all workspace data" };
}
