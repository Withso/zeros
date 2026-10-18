import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx } from "../db.js";
import { DatabaseCloudWorkspaceActionService } from "./action-receipts.js";
import { DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import { DatabaseCloudWorkspaceEventService } from "./event-streams.js";
import { DatabaseCloudWorkspaceBlobService, MemoryCloudWorkspaceObjectStore } from "./object-store.js";
import { seedRecordedCloudWorkspaceActor } from "./recorded-actor-test-fixture.js";
import { transferActive, vmTransferReport } from "./runtime-transfer-proof.test-fixtures.js";
import { DatabaseCloudRuntimeTransitionService } from "./runtime-transfer.js";
import { seedRuntimeBundle } from "./runtime-test-fixtures.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";

/** Synthetic content plus real enrollment/transfer and actor-service writes.
 * No provider or object-store network calls are involved. */
export async function seedWorkspaceDeletionGraph(pool: pg.Pool, runtimeTransfer: boolean | number = true,
  seedActorGraph = seedWorkspaceDeletionActorGraph) {
  const fixture = await seedReadyCloudWorkspace(pool);
  const scope = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
    generation: 1, engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken };
  const store = new MemoryCloudWorkspaceObjectStore();
  const objects = new DatabaseCloudWorkspaceBlobService({ pool, objectStore: store,
    encryptionKeyV1: randomBytes(32).toString("base64url"), workosEnabled: false });
  const blob = await objects.put({ ...scope, bytes: Buffer.from("synthetic deletion content") });
  const checkpointId = randomUUID(), batchId = randomUUID();
  await pool.query(`INSERT INTO workspace_content_heads(workspace_id,org_id,current_revision,durable_revision)
    VALUES($1,$2,1,1)`, [fixture.workspaceId, fixture.organizationId]);
  await pool.query(`INSERT INTO workspace_content_revisions(workspace_id,org_id,revision,parent_revision,
    authority_epoch,generation,engine_instance_id,idempotency_key,request_sha256,changed_entry_count)
    VALUES($1,$2,1,0,1,1,$3,'deletion-content',decode(repeat('a',64),'hex'),1)`,
  [fixture.workspaceId, fixture.organizationId, fixture.engineInstanceId]);
  await pool.query(`INSERT INTO workspace_record_heads(workspace_id,org_id,current_revision,last_durable_at)
    VALUES($1,$2,1,now())`, [fixture.workspaceId, fixture.organizationId]);
  await pool.query(`INSERT INTO workspace_record_batches(id,workspace_id,org_id,generation,engine_instance_id,
    authority_epoch,idempotency_key,request_sha256,first_revision,last_revision,event_count)
    VALUES($1,$2,$3,1,$4,1,'deletion-record',decode(repeat('b',64),'hex'),1,1,1)`,
  [batchId, fixture.workspaceId, fixture.organizationId, fixture.engineInstanceId]);
  await pool.query(`INSERT INTO workspace_record_events(workspace_id,org_id,revision,batch_id,entity_kind,
    entity_id,operation,document,occurred_at) VALUES($1,$2,1,$3,'chat','deletion-chat','upsert','{"title":"synthetic"}',now())`,
  [fixture.workspaceId, fixture.organizationId, batchId]);
  await pool.query(`INSERT INTO workspace_record_entities(workspace_id,org_id,entity_kind,entity_id,revision,schema_version,document)
    VALUES($1,$2,'chat','deletion-chat',1,1,'{"title":"synthetic"}')`, [fixture.workspaceId, fixture.organizationId]);
  await pool.query(`INSERT INTO workspace_checkpoints(id,workspace_id,org_id,idempotency_key,request_sha256,
    content_revision,record_revision,authority_epoch,generation,reason,manifest_blob_id,inclusion_policy,
    file_count,total_bytes,state,integrity_sha256,durable_at)
    VALUES($1,$2,$3,'deletion-checkpoint',decode(repeat('c',64),'hex'),1,1,1,1,'manual',$4,'{}',0,0,
      'durable',decode(repeat('c',64),'hex'),now())`, [checkpointId, fixture.workspaceId, fixture.organizationId, blob.id]);
  await pool.query(`UPDATE workspace_content_heads SET current_checkpoint_id=$2 WHERE workspace_id=$1`,
    [fixture.workspaceId, checkpointId]);
  await pool.query(`UPDATE cloud_workspace_generations SET recovery_checkpoint_id=$2 WHERE workspace_id=$1`,
    [fixture.workspaceId, checkpointId]);
  await pool.query(`INSERT INTO workspace_checkpoint_requests(workspace_id,generation,org_id,reason,state,
    idempotency_key,checkpoint_id,deadline_at,completed_at)
    VALUES($1,1,$2,'manual','succeeded','deletion-checkpoint-request',$3,now()+interval '1 minute',now())`,
  [fixture.workspaceId, fixture.organizationId, checkpointId]);
  await pool.query(`INSERT INTO workspace_exports(org_id,workspace_id,requested_by,checkpoint_id,record_revision,
    content_revision,idempotency_key,request_sha256,state,export_blob_id,available_at,expires_at,completed_at)
    VALUES($1,$2,$3,$4,1,1,'deletion-export',decode(repeat('d',64),'hex'),'available',$5,now(),now()+interval '1 day',now())`,
  [fixture.organizationId, fixture.workspaceId, fixture.userId, checkpointId, blob.id]);
  await pool.query(`INSERT INTO workspace_blob_references(blob_id,org_id,workspace_id,reference_kind,reference_id)
    VALUES($1,$2,$3,'checkpoint_manifest',$4)`, [blob.id, fixture.organizationId, fixture.workspaceId, checkpointId]);
  // Populated-schema migration tests supply a writer pinned to that schema.
  // Every ordinary deletion fixture still exercises today's actor services.
  await seedActorGraph(pool, fixture);
  await pool.query(`INSERT INTO cloud_workspace_setup_attestations(
    setup_run_id,workspace_id,generation,org_id,execution_fence,image_ref,image_source_commit,
    repository_revision,repository_commit,settings_version,settings_snapshot_sha256,engine_instance_id,
    engine_protocol_version,engine_health,durable_record_connected,runtime_id,runtime_manifest_sha256,
    runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version,
    runtime_installer_receipt_sha256,runtime_boot_id,runtime_supervisor_session_id)
    SELECT run.id,run.workspace_id,run.generation,run.org_id,run.execution_fence,g.image_ref,g.source_commit,
      'main',repeat('c',40),1,spec.settings_snapshot_sha256,engine.id,engine.protocol_version,'ready',true,
      g.runtime_id,g.runtime_manifest_sha256,g.runtime_base_image_id,g.runtime_base_compatibility_id,g.runtime_profile,
      g.runtime_engine_protocol_version,engine.runtime_installer_receipt_sha256,engine.runtime_boot_id,engine.runtime_supervisor_session_id
    FROM cloud_workspace_setup_runs run JOIN cloud_workspace_generations g USING(workspace_id,generation,org_id)
    JOIN cloud_workspace_setup_specs spec USING(workspace_id,generation,org_id)
    JOIN cloud_workspace_engine_instances engine ON engine.setup_run_id=run.id WHERE run.workspace_id=$1`, [fixture.workspaceId]);
  await pool.query(`UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=now(),lease_owner=NULL,
    lease_expires_at=NULL WHERE workspace_id=$1`, [fixture.workspaceId]);
  let current = { generation: 1, engineInstanceId: fixture.engineInstanceId, active: transferActive };
  for (let index = 0; index < Number(runtimeTransfer); index++) current = await transferWorkspace(pool, fixture, current);
  const writerEpoch = randomUUID(), bindingId = randomUUID(), sourceId = randomUUID();
  const bootId = (await pool.query<{ boot_id: string }>(`SELECT runtime_boot_id AS boot_id
    FROM cloud_workspace_engine_instances WHERE id=$1`, [current.engineInstanceId])).rows[0]!.boot_id;
  await pool.query(`INSERT INTO cloud_workspace_local_command_writers(workspace_id,org_id,generation,engine_instance_id,
    boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,1)`,
  [fixture.workspaceId, fixture.organizationId, current.generation, current.engineInstanceId, bootId, writerEpoch, fixture.userId]);
  await pool.query(`INSERT INTO cloud_agent_boot_bindings(id,workspace_id,org_id,generation,engine_instance_id,
    boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)`,
  [bindingId, fixture.workspaceId, fixture.organizationId, current.generation, current.engineInstanceId, bootId, writerEpoch, fixture.userId]);
  await pool.query(`UPDATE cloud_workspace_local_command_writers SET state='active',activated_at=now()
    WHERE workspace_id=$1 AND writer_epoch=$2`, [fixture.workspaceId, writerEpoch]);
  await pool.query(`UPDATE cloud_agent_boot_bindings SET credentials_initialized=true WHERE id=$1`, [bindingId]);
  await pool.query(`UPDATE cloud_workspaces SET agent_command_mode='boot-owner-v1',agent_boot_id=$2 WHERE id=$1`,
    [fixture.workspaceId, bindingId]);
  await pool.query(`INSERT INTO cloud_agent_boot_credentials(binding_id,provider,metadata,key_version,nonce,ciphertext,auth_tag)
    VALUES($1,'claude','{"status":"ready"}',1,$2,$3,$4)`, [bindingId, randomBytes(12), randomBytes(24), randomBytes(16)]);
  await pool.query(`INSERT INTO cloud_agent_boot_source_deliveries(binding_id,provider,credential_id)
    VALUES($1,'claude',$2)`, [bindingId, randomUUID()]);
  const document = '{"synthetic":"local history"}', digest = createHash("sha256").update(document).digest();
  await pool.query(`INSERT INTO cloud_workspace_local_command_history_blobs(workspace_id,org_id,document_sha256,
    kind,canonical_document,origin_writer_epoch,verified_sequence) VALUES($1,$2,$3,'manifest',$4,$5,1)`,
  [fixture.workspaceId, fixture.organizationId, digest, document, writerEpoch]);
  await pool.query(`INSERT INTO cloud_workspace_local_command_history_heads(workspace_id,org_id,projection_epoch,
    origin_writer_epoch,conversation_id,restore_revision,complete,deleted,manifest_sha256,record_sequence,event_sequence,
    source_kind,source_id,source,outbox_sequence)
    VALUES($1,$2,$3,$3,'deletion-chat',1,true,false,$4,1,1,'mutation',$5,$6::jsonb,1)`,
  [fixture.workspaceId, fixture.organizationId, writerEpoch, digest, sourceId,
    JSON.stringify({ kind: "mutation", mutationId: sourceId, operation: "edit" })]);
  return { ...fixture, current, objects, store, blobId: blob.id, bindingId, checkpointId };
}

async function seedWorkspaceDeletionActorGraph(pool: pg.Pool, fixture: ReadyCloudWorkspaceFixture) {
  const actor = await seedRecordedCloudWorkspaceActor(pool, fixture, { executionId: "deletion-execution" });
  const commands = new DatabaseCloudWorkspaceCommandService({ pool });
  await commands.mutate(actor, { conversationId: "deletion-chat", operationId: randomUUID(), expectedRevision: 0,
    action: { kind: "enqueue", commandId: randomUUID(), payload: { agentId: "claude", modeRevision: 0,
      userMessageId: randomUUID(), prompt: [{ type: "text", text: "synthetic deletion prompt" }] } } });
  await commands.claim(actor, "deletion-chat", "deletion-execution");
  await new DatabaseCloudWorkspaceEventService({ pool }).request(actor, { kind: "append", batchId: randomUUID(),
    events: [{ sequence: 1, frame: { id: randomUUID(), source: "engine", timestamp: 0,
      type: "AGENT_SESSION_UPDATE", content: "synthetic deletion event",
      cloudStream: { streamId: fixture.engineInstanceId, sequence: 1 } } }] });
  await new DatabaseCloudWorkspaceActionService({ pool }).request(actor, { kind: "begin", admissible: true,
    action: { operationId: randomUUID(), conversationId: "deletion-chat", executionId: "deletion-execution",
      kind: "permission", requestId: randomUUID(), payload: { response: { outcome: "cancelled" } } } });
}

async function transferWorkspace(pool: pg.Pool, fixture: ReadyCloudWorkspaceFixture,
  source: { generation: number; engineInstanceId: string; active: typeof transferActive }) {
  const releaseOrder = (await pool.query<{ next: number }>(`SELECT (coalesce(max(release_order),0)+1)::int AS next
    FROM cloud_runtime_channel_releases WHERE channel='alpha'`)).rows[0]!.next;
  const generation = source.generation + 1, digit = releaseOrder.toString(16), runtimeId = `r1-${digit.repeat(64)}`;
  if (digit.length !== 1) throw new Error("Deletion fixture exceeded its bounded runtime releases");
  if (!(await pool.query("SELECT 1 FROM cloud_runtime_bundles WHERE runtime_id=$1", [runtimeId])).rowCount)
    await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit, releaseOrder }));
  await pool.query(`INSERT INTO cloud_runtime_transfer_qualifications(source_runtime_id,target_runtime_id,
    controller_runtime_id,base_compatibility_id,mode,qualification_mode,enabled,evidence_sha256)
    VALUES($1,$2,$1,$3,'engine','full',true,$4) ON CONFLICT DO NOTHING`,
  [source.active.runtimeId, runtimeId, source.active.baseCompatibilityId, Buffer.alloc(32)]);
  const service = new DatabaseCloudRuntimeTransitionService({ pool, qualificationMode: "full", workosEnabled: false,
    heartbeatEndpoint: "https://control.example.test/internal/cloud-workspaces/engine/heartbeat" });
  const offered = await service.offer({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
    generation: source.generation, sourceEngineInstanceId: source.engineInstanceId, operationId: randomUUID(), mode: "engine" });
  if (!offered) throw new Error("Deletion fixture requires a real runtime offer");
  const claim = await service.claim({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
    transitionId: offered.transitionId }, "deletion-fixture-runtime");
  if (!claim) throw new Error("Deletion fixture requires a real runtime claim");
  await service.staged(claim);
  if (!await service.activate(claim, { controller: source.active,
    policy: { id: "zeros_test_deletion", async authorize() { return true; } } }))
    throw new Error("Deletion fixture requires runtime activation");
  const active = { ...source.active, runtimeId, manifestSha256: digit.repeat(64), root: `/opt/zeros-infra/${runtimeId}`,
    installerReceiptSha256: "8".repeat(64), supervisorSessionId: randomUUID() };
  const report = vmTransferReport();
  report.runtime = { ...report.runtime, runtimeId: active.runtimeId, manifestSha256: active.manifestSha256,
    installerReceiptSha256: active.installerReceiptSha256, supervisorSessionId: active.supervisorSessionId };
  const enrollment = await service.enroll(claim, { active, controller: source.active, report, rollback: false });
  if (!enrollment) throw new Error("Deletion fixture requires runtime enrollment");
  await service.register({ ...claim, generation, setupRunId: enrollment.id, executionFence: enrollment.executionFence,
    engineInstanceId: enrollment.engineInstanceId, token: enrollment.token, protocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
    actorProtocolVersion: 2, agentCustomizationVersion: 3, agentRuntime: { ...report.runtime, profile: "zeros-cloud-worker-v4" } });
  if (!await service.verifyHealth(claim, async challenge => ({ challenge, executionFence: claim.executionFence,
    active, engineInstanceId: enrollment.engineInstanceId, protocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
    health: "ready", durableRecordConnected: true }))) throw new Error("Deletion fixture requires runtime health evidence");
  if (!await service.finish(claim, { schema: "zeros.runtime-update/v1", transitionId: claim.transitionId,
    fence: claim.executionFence, scope: { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
      sourceGeneration: source.generation, candidateGeneration: generation, sourceEngineInstanceId: source.engineInstanceId },
    operation: "activate", outcome: "healthy", active })) throw new Error("Deletion fixture requires a finished runtime transfer");
  return { generation, engineInstanceId: enrollment.engineInstanceId, active };
}

export async function confirmWorkspaceDeletion(pool: pg.Pool, fixture: ReadyCloudWorkspaceFixture) {
  await pool.query(`UPDATE cloud_workspaces SET status='deleted',desired_state='deleted',deleted_at=now()
    WHERE id=$1 AND org_id=$2`, [fixture.workspaceId, fixture.organizationId]);
  await pool.query(`UPDATE cloud_workspace_provider_bindings SET observed_state='deleted',deletion_verified_at=now()
    WHERE workspace_id=$1 AND org_id=$2`, [fixture.workspaceId, fixture.organizationId]);
}
