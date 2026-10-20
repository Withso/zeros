import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { vi } from "vitest";
import { withSystemTx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { commitFinalSaveFixture, sealFinalSaveFixture, seedFinalSaveEngine } from "./final-save-test-fixtures.js";
import { requestCloudWorkspaceDeletion } from "./routes.js";
import { ensureFinalSaveRecovery } from "./final-save-recovery.js";
import { runFinalSaveRecovery } from "./final-save-service.js";
import { DatabaseCloudWorkspaceContentService } from "./content-record.js";
import { DatabaseCloudProviderOperationStore } from "./provider-operation-store.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import type { CloudProviderResource, CloudWorkspaceProvider } from "./provider.js";

const directory = new URL("../../migrations/", import.meta.url);
const recoveryBoundary = "0171_cloud_final_save_recovery.sql";
const repairBoundary = "0178_";

export async function migrateDeliveredHistory(pool: pg.Pool, stage: "old" | "adoption" | "repair") {
  const client = await pool.connect();
  try {
    const names = (await readdir(directory)).filter(name => /^\d{4}_.+\.sql$/.test(name) &&
      (stage === "old" ? name < recoveryBoundary : stage === "adoption" ? name >= recoveryBoundary && name < repairBoundary : name >= repairBoundary)).sort();
    for (const name of names) {
      await client.query("BEGIN");
      try { await client.query(await readFile(new URL(name, directory), "utf8")); await client.query("COMMIT"); }
      catch (error) { await client.query("ROLLBACK"); throw error; }
    }
  } finally { client.release(); }
}

export async function resetDeliveredHistory(pool: pg.Pool) {
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
    CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());`);
  await migrateDeliveredHistory(pool, "old");
}

/** Synthetic identities, actual pre-0171 delivered cancellation, two distinct
 * native incarnations, real final commits and real provider lifecycle workers.
 * The operator under test does not create any of the positive saved proof. */
export async function seedDeliveredHistoryRepair(pool: pg.Pool) {
  const first = await seedReadyCloudWorkspace(pool);
  const resourceId = "bx_w3hst278", account = "w3-existing-history-fixture";
  await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id=$2 WHERE workspace_id=$1", [first.workspaceId,resourceId]);
  const old = { ...first,generation:1 };
  async function writer(engineId: string) {
    const writerEpoch = randomUUID(), bindingId = randomUUID();
    const bootId = (await pool.query("SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [engineId])).rows[0].runtime_boot_id;
    await pool.query(`INSERT INTO cloud_workspace_local_command_writers
      (workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
      VALUES($1,$2,1,$3,$4,$5,$6,1)`, [first.workspaceId,first.organizationId,engineId,bootId,writerEpoch,first.userId]);
    await pool.query(`INSERT INTO cloud_agent_boot_bindings
      (id,workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch,credentials_initialized,initial_adoptions)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,1,true,
      '[{"provider":"claude","status":"missing"},{"provider":"codex","status":"missing"},{"provider":"cursor","status":"missing"}]')`,
    [bindingId,first.workspaceId,first.organizationId,engineId,bootId,writerEpoch,first.userId]);
    await pool.query("UPDATE cloud_workspace_local_command_writers SET state='active',activated_at=clock_timestamp() WHERE writer_epoch=$1", [writerEpoch]);
    await pool.query("UPDATE cloud_workspaces SET agent_command_mode='boot-owner-v1',agent_boot_id=$2 WHERE id=$1", [first.workspaceId,bindingId]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1 WHERE id=$1", [engineId]);
    return { writerEpoch,bindingId };
  }
  const firstWriter = await writer(first.engineInstanceId);
  const stopId = randomUUID(), requestId = randomUUID();
  await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
    (id,workspace_id,org_id,generation,operation,state,completed_at,idempotency_key,request_sha256,error_code)
    VALUES($1::uuid,$2,$3,1,'stop','superseded',clock_timestamp(),'system:compute-stop:'||$1::text,digest($1::text,'sha256'),'workspace_active')`,
  [stopId,first.workspaceId,first.organizationId]);
  await pool.query(`INSERT INTO workspace_checkpoint_requests
    (id,workspace_id,org_id,generation,lifecycle_intent_id,reason,state,idempotency_key,
     deadline_at,completed_at,error_code,delivery_count,last_delivered_at)
    VALUES($1::uuid,$2,$3,1,$4::uuid,'before_stop','cancelled','compute.'||$4::text,
      clock_timestamp()+interval '5 minutes',clock_timestamp(),'workspace_active',3,clock_timestamp())`,
  [requestId,first.workspaceId,first.organizationId,stopId]);
  await migrateDeliveredHistory(pool, "adoption");

  const journal = new DatabaseCloudProviderOperationStore(pool,"boat",account);
  await pool.query(`INSERT INTO cloud_workspace_provider_operations
    (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,create_attempts_tracked,resource_id)
    VALUES('boat',$1,$2,1,$3,$4,$5,true,$6)`, [account,first.workspaceId,first.organizationId,randomUUID(),"a".repeat(64),resourceId]);
  let resource: CloudProviderResource | null = { resourceId,workspaceId:first.workspaceId,
    generation:1,state:"running",target:"test-region",metadata:{} };
  const provider = { name:"boat",find:vi.fn(async () => resource ? [resource] : []),inspect:vi.fn(async () => resource),
    stop:vi.fn(async () => { resource={ ...resource!,state:"stopped" }; return resource; }),
    delete:vi.fn(async () => {
      const operationId = randomUUID();
      await journal.beginDelete(resourceId); await journal.bindDeletion(resourceId,operationId);
      await journal.completeDeletion(resourceId,operationId); resource=null;
    }),verifyAbsence:vi.fn(async () => true),verifyManagedResourceOwnership:vi.fn(async () => true),
    create:vi.fn(),start:vi.fn(),archive:vi.fn() };
  const logger = { error:vi.fn(),warn:vi.fn(),info:vi.fn() };
  const reconciler = new CloudWorkspaceReconciler({ pool,provider:provider as unknown as CloudWorkspaceProvider,
    workerId:"w3-existing-history-provider",logger });

  // A separate later Stop really saves and retires the old native source.
  // Its checkpoint must never be attributed to the earlier cancelled request.
  await sealFinalSaveFixture(pool,old);
  const savedStopId = randomUUID();
  await withSystemTx(pool, async tx => {
    await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,1,$4,'stop',$1::text,digest($1::text,'sha256'))`,
    [savedStopId,first.workspaceId,first.organizationId,first.userId]);
    await tx.query("UPDATE cloud_workspaces SET accepted_lifecycle_intent_id=$2 WHERE id=$1", [first.workspaceId,savedStopId]);
  });
  await commitFinalSaveFixture(pool,old,{ intentId:savedStopId,userId:first.userId,reason:"before_stop" });
  await reconciler.runOnce(first.workspaceId);
  if ((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1",[savedStopId])).rows[0].state !== "succeeded")
    throw new Error("Historical fixture must complete its actual saved Stop");

  const successor = await withSystemTx(pool, tx => seedFinalSaveEngine(tx,{ ...first,userId:first.userId,setupAttempt:2 }));
  const secondWriter = await writer(successor.engineInstanceId);
  await pool.query("UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1",[first.workspaceId]);
  const allocationLeaseId = randomUUID();
  await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
    (id,workspace_id,org_id,generation,requested_by,operation,state,completed_at,idempotency_key,request_sha256)
    VALUES($1::uuid,$2,$3,1,$4,'wake','succeeded',clock_timestamp(),$1::text,digest($1::text,'sha256'))`,
  [allocationLeaseId,first.workspaceId,first.organizationId,first.userId]);
  await pool.query(`INSERT INTO managed_compute_allocation_leases
    (id,workspace_id,org_id,generation,billing_epoch,user_id,lifecycle_intent_id,provider,provider_resource_id,policy_id,
     seconds_per_dollar,weight_numerator,weight_denominator,ttl_seconds,state,requested_at,funded_until,provider_expires_at,settled_at,stopped_observed_at)
    VALUES($1,$2,$3,1,1,$4,$1,'boat',$5,'fixture',1000,1,1,600,'settled',now()-interval '10 minutes',
      now()-interval '1 minute',now()-interval '1 minute',now(),now())`,
  [allocationLeaseId,first.workspaceId,first.organizationId,first.userId,resourceId]);
  await pool.query("UPDATE cloud_workspaces SET status='ready',desired_state='running',accepted_lifecycle_intent_id=$2 WHERE id=$1",[first.workspaceId,allocationLeaseId]);
  resource={ ...resource!,state:"running" };
  const revision=Number((await pool.query("SELECT current_revision FROM workspace_content_heads WHERE workspace_id=$1",[first.workspaceId])).rows[0].current_revision);
  await new DatabaseCloudWorkspaceContentService({pool,workosEnabled:false}).append({ ...successor,expectedRevision:revision,
    idempotencyKey:randomUUID(),gitBaseCommit:"a".repeat(40),gitHeadRef:null,mutations:[{path:"saved.txt",operation:"delete"}] });
  await sealFinalSaveFixture(pool,successor);
  const deletion = await withSystemTx(pool, tx => requestCloudWorkspaceDeletion(tx,{ ...first,actorUserId:first.userId,
    idempotencyKey:`w3-existing-delete:${randomUUID()}` }));
  const deleteId = deletion.intent.id;
  await commitFinalSaveFixture(pool,successor,{ intentId:deleteId,userId:first.userId,reason:"before_delete" });
  await reconciler.runOnce(first.workspaceId);
  if ((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1",[deleteId])).rows[0].state !== "succeeded")
    throw new Error("Historical fixture must complete its actual ordinary Delete");

  // Reproduce the already-adopted production state while 0177 is still live.
  // This occurs before the new migration, so a recurrence filter cannot hide it.
  await withSystemTx(pool, tx => ensureFinalSaveRecovery(tx,stopId));
  await pool.query("UPDATE cloud_workspace_final_save_recoveries SET next_attempt_at=clock_timestamp() WHERE lifecycle_intent_id=$1",[stopId]);
  await runFinalSaveRecovery(pool,first.workspaceId,false);
  await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1",[first.userId]);
  const slug = (await pool.query("SELECT slug FROM organizations WHERE id=$1",[first.organizationId])).rows[0].slug as string;
  const request = { version:1 as const,mode:"existing-delete" as const,channel:"development" as const,operationId:randomUUID(),
    organizationId:first.organizationId,expectedOrganizationSlug:slug,workspaceId:first.workspaceId,ownerUserId:first.userId,operatorUserId:first.userId,
    sourceGeneration:1,deleteIntentId:deleteId,recoveryIntentId:stopId,engineInstanceId:first.engineInstanceId,allocationLeaseId,
    providerResourceId:resourceId,providerAccountScope:account,ownerAcknowledgedCompleteDataLoss:true as const,
    ownerApprovalReference:"Synthetic owner explicitly approves complete loss of this historical recovery",
    reason:"Synthetic delivered legacy cancellation blocks an already completed ordinary Delete" };
  await migrateDeliveredHistory(pool,"repair");
  return { ...first,stopId,requestId,deleteId,savedStopId,successor,request,allocationLeaseId,resourceId,account,
    firstWriter,secondWriter,provider,logger };
}
