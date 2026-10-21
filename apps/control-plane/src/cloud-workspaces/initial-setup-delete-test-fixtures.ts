import { createHash,randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { requestCloudWorkspaceDeletion } from "./routes.js";

/** Initial creation has an allocated VM and setup execution, but has never
 * registered an engine or activated a native writer when Delete is admitted. */
export async function seedInitialSetupDelete(pool: pg.Pool) {
  const f = await seedReadyCloudWorkspace(pool, { setupPending: true });
  const createId = randomUUID(), leaseId = randomUUID(), key = randomUUID();
  const resourceId = `sandbox-${f.workspaceId}`;
  await withSystemTx(pool, async tx => {
    await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,requested_by,operation,state,completed_at,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,1,$4,'create','succeeded',now(),$1::text,digest($1::text,'sha256'))`,
    [createId,f.workspaceId,f.organizationId,f.userId]);
    await tx.query(`INSERT INTO managed_compute_allocation_leases
      (id,workspace_id,org_id,generation,billing_epoch,user_id,lifecycle_intent_id,provider,provider_resource_id,
       policy_id,seconds_per_dollar,weight_numerator,weight_denominator,ttl_seconds,state,funded_until,provider_expires_at)
      VALUES($1,$2,$3,1,1,$4,$5,'boat',$6,'fixture',1000,1,1,600,'active',now()+interval '10 minutes',now()+interval '9 minutes')`,
    [leaseId,f.workspaceId,f.organizationId,f.userId,createId,resourceId]);
  });
  const deletion = await withSystemTx(pool, tx => requestCloudWorkspaceDeletion(tx, {
    workspaceId:f.workspaceId,organizationId:f.organizationId,actorUserId:f.userId,idempotencyKey:key,
  }));
  const bootId=(await pool.query("SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1",[f.engineInstanceId])).rows[0].runtime_boot_id as string;
  const writerEpoch=randomUUID(),bindingId=randomUUID();
  const scope={workspaceId:f.workspaceId,organizationId:f.organizationId,generation:1,
    engineInstanceId:f.engineInstanceId,heartbeatToken:f.heartbeatToken};
  const ready = () => withSystemTx(pool, async tx => {
    await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE",[f.organizationId]);
    await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE",[f.workspaceId]);
    await tx.query(`UPDATE cloud_workspace_engine_instances SET state='ready',registered_at=clock_timestamp(),
      last_heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '10 minutes',
      heartbeat_token_hash=$2,cloud_local_commands_version=1,final_save_version=1 WHERE id=$1`,
    [f.engineInstanceId,createHash("sha256").update(f.heartbeatToken).digest()]);
    await tx.query(`INSERT INTO cloud_workspace_local_command_writers
      (workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
      VALUES($1,$2,1,$3,$4,$5,$6,1)`,[f.workspaceId,f.organizationId,f.engineInstanceId,bootId,writerEpoch,f.userId]);
    await tx.query(`INSERT INTO cloud_agent_boot_bindings
      (id,workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch,
       credentials_initialized,initial_adoptions) VALUES($1,$2,$3,1,$4,$5,$6,$7,1,true,
       '[{"provider":"claude","status":"missing"},{"provider":"codex","status":"missing"},{"provider":"cursor","status":"missing"}]')`,
    [bindingId,f.workspaceId,f.organizationId,f.engineInstanceId,bootId,writerEpoch,f.userId]);
    await tx.query("UPDATE cloud_workspace_local_command_writers SET state='active',activated_at=clock_timestamp() WHERE writer_epoch=$1",[writerEpoch]);
    await tx.query("UPDATE cloud_workspaces SET agent_command_mode='boot-owner-v1',agent_boot_id=$2 WHERE id=$1",[f.workspaceId,bindingId]);
    await tx.query("UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1",[f.workspaceId]);
    await tx.query("UPDATE cloud_workspaces SET status='ready',updated_at=clock_timestamp() WHERE id=$1",[f.workspaceId]);
  });
  return {...f,scope,createId,leaseId,key,resourceId,deleteId:deletion.intent.id,bootId,writerEpoch,bindingId,ready};
}
