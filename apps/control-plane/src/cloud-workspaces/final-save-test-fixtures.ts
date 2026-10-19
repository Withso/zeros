import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import { enqueueWorkspaceCheckpointRequest, deliverWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import { DatabaseCloudFinalSaveService } from "./final-save-service.js";
import { DatabaseCloudWorkspaceBlobService } from "./object-store.js";
import { DatabaseCloudWorkspaceContentService } from "./content-record.js";
import { canonicalFinalSaveJson, type CloudFinalSaveRequest } from "./final-save-contract.js";
import { DatabaseCloudWorkspaceCommandService } from "./commands.js";

type FixtureSource = { workspaceId: string; organizationId: string; generation: number;
  engineInstanceId: string; heartbeatToken: string };

export async function sealFinalSaveFixture(pool: pg.Pool, source: FixtureSource) {
  const writer = (await pool.query(`SELECT writer.*,binding.funding_owner_user_id,binding.funding_owner_epoch
    FROM cloud_workspace_local_command_writers writer JOIN cloud_agent_boot_bindings binding
      ON binding.workspace_id=writer.workspace_id AND binding.org_id=writer.org_id AND binding.writer_epoch=writer.writer_epoch
    WHERE writer.workspace_id=$1 AND writer.org_id=$2 AND writer.engine_instance_id=$3 AND writer.state='active'`,
  [source.workspaceId,source.organizationId,source.engineInstanceId])).rows[0];
  if (!writer) throw new Error("Final save fixture requires its live writer");
  const head = (await pool.query(`SELECT coalesce(max(record_sequence),0)::text AS records,coalesce(max(event_sequence),0)::text AS events
    FROM cloud_workspace_local_command_history_heads WHERE workspace_id=$1 AND org_id=$2 AND projection_epoch=$3`,
  [source.workspaceId,source.organizationId,writer.writer_epoch])).rows[0];
  const descriptor = {version:1,scope:{workspaceId:source.workspaceId,organizationId:source.organizationId,generation:source.generation,
    engineInstanceId:source.engineInstanceId,bootId:writer.boot_id,writerEpoch:writer.writer_epoch,
    fundingOwnerUserId:writer.funding_owner_user_id,fundingOwnerEpoch:Number(writer.funding_owner_epoch)},
    sealId:randomUUID(),sequence:Number(writer.mirrored_sequence),recordSequence:Number(head.records),eventSequence:Number(head.events),
    inventorySha256:createHash("sha256").update("synthetic final-save inventory").digest("hex")};
  const seal={...descriptor,sha256:createHash("sha256").update(canonicalFinalSaveJson(descriptor)).digest("hex")};
  const ack=await new DatabaseCloudWorkspaceCommandService({pool}).seal(source,seal);
  return {seal,ack};
}

/** An enrolled source for lifecycle tests that previously modeled only a
 * provider binding. Call before accepting the destructive intent so its
 * immutable source is the engine that actually produces the final commit. */
export async function seedFinalSaveEngine(tx: Tx, input: {
  workspaceId: string; organizationId: string; userId: string; generation?: number; setupAttempt?: number;
}): Promise<FixtureSource> {
  const generation = input.generation ?? 1;
  const engineInstanceId = randomUUID(), setupRunId = randomUUID(), grantId = randomUUID();
  const heartbeatToken = `zwh_${randomBytes(32).toString("base64url")}`;
  await tx.query(`INSERT INTO cloud_workspace_setup_runs
    (id,workspace_id,org_id,generation,attempt,state,claim_count,execution_fence,lease_owner,lease_expires_at,last_heartbeat_at,started_at)
    VALUES($1,$2,$3,$4,$5,'running',1,1,'saved-source-fixture',now()+interval '10 minutes',now(),now())`,
  [setupRunId,input.workspaceId,input.organizationId,generation,input.setupAttempt ?? 1]);
  await tx.query(`INSERT INTO cloud_workspace_endpoint_grants
    (id,workspace_id,org_id,generation,account_user_id,purpose,audience,token_hash,account_revision,authorization_revision,
     expires_at,consumed_at,setup_run_id,setup_execution_fence)
    SELECT $1,$2,$3,$4,$5,CASE WHEN runtime_id IS NULL THEN 'engine-connect' ELSE 'setup' END,
      'fixture',$6,1,1,now()+interval '10 minutes',now(),CASE WHEN runtime_id IS NULL THEN NULL ELSE $7::uuid END,
      CASE WHEN runtime_id IS NULL THEN NULL ELSE 1 END
    FROM cloud_workspace_generations WHERE workspace_id=$2 AND generation=$4`,
  [grantId,input.workspaceId,input.organizationId,generation,input.userId,randomBytes(32),setupRunId]);
  await tx.query(`INSERT INTO cloud_workspace_engine_instances
    (id,workspace_id,org_id,generation,account_user_id,setup_run_id,setup_execution_fence,registration_grant_id,protocol_version,
     state,bridge_token_hash,heartbeat_token_hash,registered_at,last_heartbeat_at,lease_expires_at,
     actor_protocol_version,agent_customization_version,runtime_id,runtime_manifest_sha256,runtime_base_image_id,
     runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version,runtime_installer_receipt_sha256,
     runtime_boot_id,runtime_supervisor_session_id)
    SELECT $1,$2,$3,$4,$5,$6,1,$7,CASE WHEN runtime_id IS NULL THEN 11 ELSE $10 END,'ready',$8,$9,
      now(),now(),now()+interval '10 minutes',2,3,runtime_id,runtime_manifest_sha256,runtime_base_image_id,
      runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version,
      CASE WHEN runtime_id IS NULL THEN NULL ELSE repeat('8',64) END,
      CASE WHEN runtime_id IS NULL THEN NULL ELSE gen_random_uuid() END,
      CASE WHEN runtime_id IS NULL THEN NULL ELSE gen_random_uuid() END
    FROM cloud_workspace_generations WHERE workspace_id=$2 AND generation=$4`,
  [engineInstanceId,input.workspaceId,input.organizationId,generation,input.userId,setupRunId,grantId,
    randomBytes(32),createHash("sha256").update(heartbeatToken).digest(),CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION]);
  return { workspaceId:input.workspaceId,organizationId:input.organizationId,generation,engineInstanceId,heartbeatToken };
}

/** Exercise real upload, content, request-completion and final-fence code.
 * This is only for unrelated positive dispatch fixtures, never a substitute
 * for the explicit missing-proof and failed-save controls. */
export async function commitFinalSaveFixture(pool: pg.Pool, source: FixtureSource, input: {
  intentId: string; userId: string; reason: "before_stop" | "before_archive" | "before_delete" | "before_rebuild";
}) {
  await pool.query(`INSERT INTO cloud_workspace_object_storage_limits(org_id,max_organization_bytes,max_workspace_bytes,updated_by)
    VALUES($1,107374182400,10737418240,$2) ON CONFLICT (org_id) DO NOTHING`, [source.organizationId,input.userId]);
  const objects = new Map<string,Buffer>();
  const blobs = new DatabaseCloudWorkspaceBlobService({ pool,workosEnabled:false,encryptionKeyV1:randomBytes(32).toString("base64url"),objectStore:{
    async putIfAbsent(key,value) { if(objects.has(key))return "already_exists";objects.set(key,Buffer.from(value));return "created"; },
    async get(key) { return objects.get(key) ?? null; },async delete(key) {objects.delete(key);},async deleteAndFence(key){objects.delete(key);},
    async sweepAbandonedUploads(){return 0;},
  }});
  const content = new DatabaseCloudWorkspaceContentService({pool,workosEnabled:false});
  const manifest = await blobs.put({...source,bytes:Buffer.from("saved lifecycle fixture")});
  let revision = Number((await pool.query("SELECT current_revision FROM workspace_content_heads WHERE workspace_id=$1", [source.workspaceId])).rows[0]?.current_revision ?? 0);
  if (!revision) revision = (await content.append({...source,expectedRevision:0,idempotencyKey:randomUUID(),gitBaseCommit:"a".repeat(40),gitHeadRef:null,
    mutations:[{path:"saved.txt",operation:"upsert",entryType:"file",mode:33188,blobId:manifest.id,contentSha256:manifest.plaintextSha256,sizeBytes:23}]})).revision;
  const request = await withSystemTx(pool, async tx => {
    await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [source.organizationId]);
    await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [source.workspaceId]);
    const previous=(await tx.query<{id:string}>("SELECT id FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1",[input.intentId])).rows[0];
    return previous ?? enqueueWorkspaceCheckpointRequest(tx,{...source,requestedBy:input.userId,lifecycleIntentId:input.intentId,
      reason:input.reason,idempotencyKey:`saved-source.${input.intentId}`});
  });
  const counts = (await pool.query(`SELECT count(*)::integer AS files,coalesce(sum(size_bytes),0)::bigint AS bytes
    FROM workspace_file_entries WHERE workspace_id=$1 AND org_id=$2 AND tombstoned_at IS NULL`,[source.workspaceId,source.organizationId])).rows[0];
  const receipt = await content.commitCheckpoint({...source,requestId:request.id,idempotencyKey:`commit.${request.id}`,contentRevision:revision,
    reason:input.reason,manifestBlobId:manifest.id,artifactBlobId:null,inclusionPolicy:{},fileCount:counts.files,totalBytes:Number(counts.bytes),
    integritySha256:manifest.plaintextSha256});
  return {request,receipt};
}

/** Real relational source with a sealed writer. Native custody/retirement is
 * independently exercised by engine tests; no fixture shortcut enters product. */
export async function seedFinalSave(pool: pg.Pool) {
  const fixture = await seedReadyCloudWorkspace(pool);
  const scope = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
    generation: 1, engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken };
  const bootId = (await pool.query("SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [scope.engineInstanceId])).rows[0].runtime_boot_id as string;
  const writerEpoch = randomUUID(), bindingId = randomUUID(), allocationLeaseId = randomUUID(), fundingIntentId = randomUUID();
  await withSystemTx(pool, async tx => {
    await tx.query(`INSERT INTO cloud_workspace_local_command_writers
      (workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
      VALUES($1,$2,1,$3,$4,$5,$6,1)`, [scope.workspaceId,scope.organizationId,scope.engineInstanceId,bootId,writerEpoch,fixture.userId]);
    await tx.query(`INSERT INTO cloud_agent_boot_bindings
      (id,workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch,
       credentials_initialized,initial_adoptions) VALUES($1,$2,$3,1,$4,$5,$6,$7,1,true,
         '[{"provider":"claude","status":"missing"},{"provider":"codex","status":"missing"},{"provider":"cursor","status":"missing"}]')`,
    [bindingId,scope.workspaceId,scope.organizationId,scope.engineInstanceId,bootId,writerEpoch,fixture.userId]);
    await tx.query("UPDATE cloud_workspace_local_command_writers SET state='active',activated_at=now() WHERE writer_epoch=$1", [writerEpoch]);
    await tx.query("UPDATE cloud_workspaces SET agent_command_mode='boot-owner-v1',agent_boot_id=$2 WHERE id=$1", [scope.workspaceId,bindingId]);
    await tx.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1,final_save_version=1 WHERE id=$1", [scope.engineInstanceId]);
    const seal = { version: 1, scope: { ...scope, heartbeatToken: undefined, bootId, writerEpoch,
      fundingOwnerUserId: fixture.userId, fundingOwnerEpoch: 1 }, sealId: randomUUID(), sequence: 0, recordSequence: 0,
      eventSequence: 0, inventorySha256: "a".repeat(64), sha256: "b".repeat(64) };
    const { scope: _scope, ...descriptor } = seal;
    await tx.query(`UPDATE cloud_workspace_local_command_writers SET sealed_sequence=0,seal_record_sequence=0,seal_event_sequence=0,
      seal=$2::jsonb,seal_ack=$3::jsonb WHERE writer_epoch=$1`, [writerEpoch,JSON.stringify(seal),JSON.stringify({ ...descriptor,writerEpoch })]);
    await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,requested_by,operation,state,completed_at,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,1,$4,'create','succeeded',now(),$1::text,digest($1::text,'sha256'))`,
    [fundingIntentId,scope.workspaceId,scope.organizationId,fixture.userId]);
    await tx.query(`INSERT INTO managed_compute_allocation_leases
      (id,workspace_id,org_id,generation,billing_epoch,user_id,lifecycle_intent_id,provider,provider_resource_id,
       policy_id,seconds_per_dollar,weight_numerator,weight_denominator,ttl_seconds,state,funded_until,provider_expires_at)
      VALUES($1,$2,$3,1,1,$4,$5,'boat',$6,'fixture',1000,1,1,600,'active',now()+interval '10 minutes',now()+interval '9 minutes')`,
    [allocationLeaseId,scope.workspaceId,scope.organizationId,fixture.userId,fundingIntentId,`sandbox-${scope.workspaceId}`]);
  });
  const intentId = randomUUID();
  const request = await withSystemTx(pool, async tx => {
    await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [scope.organizationId]);
    await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [scope.workspaceId]);
    await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,1,$4,'stop',$1::text,digest($1::text,'sha256'))`, [intentId,scope.workspaceId,scope.organizationId,fixture.userId]);
    await tx.query("UPDATE cloud_workspaces SET accepted_lifecycle_intent_id=$2 WHERE id=$1",[scope.workspaceId,intentId]);
    return enqueueWorkspaceCheckpointRequest(tx, { ...scope, requestedBy: fixture.userId, lifecycleIntentId: intentId,
      reason: "before_stop", idempotencyKey: `final.${intentId}` });
  });
  const delivery = () => withSystemTx(pool, tx => deliverWorkspaceCheckpointRequest(tx, { ...scope, finalSaveVersion: 1 }));
  const directive = (await delivery())!;
  if (!directive.finalSave) throw new Error("final save fixture did not negotiate");
  const custodyId = randomUUID();
  const report = (kind: "retry" | "reconcile" = "retry"): CloudFinalSaveRequest => ({ version: 1, kind,
    workspaceId: scope.workspaceId, organizationId: scope.organizationId, generation: 1, engineInstanceId: scope.engineInstanceId,
    recoveryId: intentId, requestId: request.id, attemptOrdinal: 0, sourceSha256: directive.finalSave!.sourceSha256,
    custodyId, commit: null, ...(kind === "retry" ? { failure: "capture_failed" as const } : {}) } as CloudFinalSaveRequest);
  const service = new DatabaseCloudFinalSaveService(pool, false);
  const send = (input = report()) => service.report({ ...input, token: fixture.heartbeatToken });
  const due = () => pool.query("UPDATE cloud_workspace_final_save_recoveries SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE lifecycle_intent_id=$1", [intentId]);
  const expire = () => pool.query("UPDATE workspace_checkpoint_requests SET created_at=clock_timestamp()-interval '6 minutes',deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [request.id]);
  const row = async () => (await pool.query("SELECT * FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [intentId])).rows[0];
  async function prepareCommit(requestId = request.id) {
    const objects = new Map<string,Buffer>();
    const blobs = new DatabaseCloudWorkspaceBlobService({ pool,workosEnabled:false,encryptionKeyV1:randomBytes(32).toString("base64url"),objectStore:{
      async putIfAbsent(key,value) { if(objects.has(key))return "already_exists";objects.set(key,Buffer.from(value));return "created"; },
      async get(key) { return objects.get(key) ?? null; },async delete(key) {objects.delete(key);},async deleteAndFence(key){objects.delete(key);},
      async sweepAbandonedUploads(){return 0;},
    }});
    const content = new DatabaseCloudWorkspaceContentService({ pool,workosEnabled:false });
    const blob = await blobs.put({ ...scope,bytes:Buffer.from("saved") });
    await content.append({ ...scope,expectedRevision:0,idempotencyKey:randomUUID(),gitBaseCommit:"a".repeat(40),gitHeadRef:null,
      mutations:[{path:"file.txt",operation:"upsert",entryType:"file",mode:33188,blobId:blob.id,contentSha256:blob.plaintextSha256,sizeBytes:5}] });
    const body = { workspaceId:scope.workspaceId,organizationId:scope.organizationId,generation:1,engineInstanceId:scope.engineInstanceId,
      requestId,idempotencyKey:`checkpoint.${requestId}.commit`,contentRevision:1,reason:"before_stop" as const,
      manifestBlobId:blob.id,artifactBlobId:null,inclusionPolicy:{},fileCount:1,totalBytes:5,integritySha256:blob.plaintextSha256 };
    const { workspaceId:_w,organizationId:_o,engineInstanceId:_e,idempotencyKey:_i,...digestBody } = body;
    const serialized = JSON.stringify(body);
    const commit = { idempotencyKey:body.idempotencyKey,requestSha256:createHash("sha256").update(canonicalFinalSaveJson(digestBody)).digest("hex"),
      bodySha256:createHash("sha256").update(serialized).digest("hex") };
    return { body,serialized,commit,content,run:() => content.commitCheckpoint({ ...body,heartbeatToken:scope.heartbeatToken,serializedBodySha256:commit.bodySha256 }) };
  }
  return { fixture,scope,bootId,writerEpoch,bindingId,allocationLeaseId,intentId,request,directive,service,report,send,due,expire,row,delivery,prepareCommit };
}
