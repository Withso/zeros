import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { loadConfig, type CloudWorkspaceBackendConfig } from "./config.js";
import { createMigrationPool, type Tx } from "./db.js";
import { audit } from "./audit.js";
import { CloudOwnerCheckpointRecoveryError, CloudOwnerCheckpointRecoverySchema, ownerRecoveryDigest,
  ownerRecoveryTarget, requireOwnerRecovery as check, type CloudOwnerCheckpointRecoveryRequest } from "./cloud-owner-checkpoint-recovery-contract.js";
import { CloudFinalSaveRequestSchema, CloudFinalSaveSourceSchema } from "./cloud-workspaces/final-save-contract.js";
import { createCloudRecoveryTransition, requireCloudRecoveryPoint } from "./cloud-workspaces/automatic-recovery.js";
import { selectCheckpointComputerSource } from "./cloud-workspaces/checkpoint-computer-source.js";
import { cloudRuntimeQualificationMode } from "./cloud-workspaces/runtime-config.js";
import { authorizeCloudWorkspaceActor } from "./cloud-workspaces/actors.js";
import { authorizeCloudWorkspaceOperation } from "./cloud-workspaces/authorization.js";
import { BOAT_RESOURCE_ID_PATTERN, BoatApiClient } from "./cloud-workspaces/boat-client.js";
import { assertInventoryAccount, assertInventoryComplete, databaseClock, inventoryDigest, readBoatInventory,
  type ProviderInventory } from "./cloud-provider-evidence.js";
import { lookupBoatResource, type ProviderLookup } from "./manage-cloud-provider-loss.js";
import { manageCloudOwnerCheckpointRetry } from "./cloud-workspaces/owner-checkpoint-retry.js";

export type CloudOwnerCheckpointRecoveryResult = {
  state: "planned" | "restoring" | "unchanged";
  approval: string;
  receiptId: string;
  transitionId: string | null;
  transitionState: string | null;
  candidateGeneration: number;
};

export type OwnerRecoveryLossEvidence = { inventory: ProviderInventory; lookup: ProviderLookup };
export type OwnerCheckpointRecoveryOptions = { databaseUrl:string; config:CloudWorkspaceBackendConfig; workosEnabled:boolean; execute?:boolean;
  approval?:string|undefined; lossEvidence?:OwnerRecoveryLossEvidence };
type Options = OwnerCheckpointRecoveryOptions;

async function readPlan(tx: Tx, request: CloudOwnerCheckpointRecoveryRequest, options: Options) {
  const workspace = (await tx.query(`SELECT * FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE`,
    [request.workspaceId,request.organizationId])).rows[0];
  check(workspace && workspace.current_generation===request.sourceGeneration && workspace.owner_user_id===request.ownerUserId &&
    workspace.deleted_at===null && workspace.desired_state!=="deleted", "owner_recovery_workspace_changed");
  await authorizeCloudWorkspaceActor(tx,{...request,actorUserId:request.ownerUserId,capability:"manage"});
  const authorization=await authorizeCloudWorkspaceOperation(tx,{...request,actorUserId:request.ownerUserId,billingOwnerUserId:request.ownerUserId,
    teamId:workspace.team_id,workosEnabled:options.workosEnabled,requireWorkspaceOwner:true});
  const recovery = (await tx.query(`SELECT * FROM cloud_workspace_final_save_recoveries
    WHERE lifecycle_intent_id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4 FOR UPDATE`,
  [request.recoveryId,request.workspaceId,request.organizationId,request.sourceGeneration])).rows[0];
  check(recovery && ["capturing","retrying","reconciling","blocked"].includes(recovery.state) && recovery.operation==="stop" &&
    recovery.current_request_id===request.requestId && recovery.custody_id===request.custodyId &&
    recovery.provider_resource_id===request.providerResourceId && recovery.checkpoint_id===null && recovery.proven_request_id===null &&
    recovery.funding_owner_user_id===request.ownerUserId,
  "owner_recovery_capture_changed");
  const source = CloudFinalSaveSourceSchema.safeParse({ organizationId:recovery.org_id,workspaceId:recovery.workspace_id,
    generation:recovery.generation,engineInstanceId:recovery.engine_instance_id,runtimeId:recovery.runtime_id,bootId:recovery.boot_id,
    writerEpoch:recovery.writer_epoch,fundingOwnerUserId:recovery.funding_owner_user_id,fundingOwnerEpoch:Number(recovery.funding_owner_epoch),
    authorityEpoch:Number(recovery.authority_epoch),registeredAtMs:recovery.registered_at?.getTime(),
    allocationLeaseId:recovery.allocation_lease_id,providerResourceId:recovery.provider_resource_id });
  check(source.success,"owner_recovery_source_unavailable");
  const sourceSha256 = ownerRecoveryDigest(source.data);
  const capture = (await tx.query(`SELECT * FROM workspace_checkpoint_requests WHERE id=$1 AND workspace_id=$2 AND org_id=$3 FOR UPDATE`,
    [request.requestId,request.workspaceId,request.organizationId])).rows[0];
  check(capture && ["expired","failed","cancelled"].includes(capture.state) && capture.completed_at && capture.checkpoint_id===null &&
    capture.generation===request.sourceGeneration && capture.reason==="before_stop" &&
    capture.final_save_recovery_id===request.recoveryId && capture.final_save_attempt_ordinal===recovery.attempt_ordinal &&
    capture.final_save_retirement_id===request.retirementId && capture.final_save_commit_report===null,"owner_recovery_capture_not_retired");
  for (const [kind,value] of [["retry",capture.final_save_capture_report],["reconcile",capture.final_save_reconcile_report]] as const) {
    const report = CloudFinalSaveRequestSchema.safeParse(value);
    check(report.success && report.data.kind===kind && report.data.commit===null && report.data.custodyId===request.custodyId &&
      report.data.sourceSha256===sourceSha256.toString("hex") && report.data.requestId===request.requestId &&
      report.data.recoveryId===request.recoveryId && report.data.attemptOrdinal===recovery.attempt_ordinal &&
      report.data.engineInstanceId===source.data.engineInstanceId && report.data.workspaceId===request.workspaceId &&
      report.data.organizationId===request.organizationId && report.data.generation===request.sourceGeneration,"owner_recovery_custody_changed");
  }
  const intents = (await tx.query(`SELECT * FROM cloud_workspace_lifecycle_intents
    WHERE workspace_id=$1 AND org_id=$2 AND (id=ANY($3::uuid[]) OR state IN ('queued','observing','dispatching')) FOR UPDATE`,
  [request.workspaceId,request.organizationId,[request.stopIntentId,request.wakeIntentId,
    ...(request.safetyStop ? [request.safetyStop.intentId] : [])]])).rows;
  const stop = intents.find(row => row.id===request.stopIntentId), wake = intents.find(row => row.id===request.wakeIntentId);
  check(intents.length===(request.safetyStop ? 3 : 2) && stop && wake && stop.operation==="stop" && wake.operation==="wake" &&
    wake.resume_after_intent_id===stop.id && wake.restart_version===1 &&
    ["queued","observing"].includes(stop.state) &&
    (request.safetyStop ? wake.state==="superseded" : ["queued","observing"].includes(wake.state)) &&
    [stop,wake].every(row => row.generation===request.sourceGeneration &&
      row.requested_by===request.ownerUserId && row.attempt_count===0 && row.dispatched_at===null &&
      row.lease_owner===null && row.generation_transition_id===null),"owner_recovery_lifecycle_changed");
  let safetySourceSha256: Buffer | null = null;
  if (request.safetyStop) {
    // Freeze both rows before consulting the shared SQL gate. A later delivery,
    // capture report or successor cannot be hidden by a once-valid plan.
    await tx.query("SELECT lifecycle_intent_id FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1 FOR UPDATE",
      [request.safetyStop.intentId]);
    await tx.query("SELECT id FROM workspace_checkpoint_requests WHERE id=$1 FOR UPDATE",[request.safetyStop.requestId]);
    await tx.query("SELECT id FROM managed_compute_allocation_leases WHERE id=$1 FOR UPDATE",[source.data.allocationLeaseId]);
    safetySourceSha256=(await tx.query<{ digest:Buffer|null }>("SELECT cloud_owner_discard_recovery_digest($1) AS digest",
      [request.safetyStop.intentId])).rows[0]!.digest;
    check(safetySourceSha256 && (await tx.query<{ matches:boolean }>(`SELECT cloud_owner_discard_safety_stop_matches($1,$2,$3,$4,$5,$6,$7,$8) AS matches`,
      [request.workspaceId,request.organizationId,request.sourceGeneration,request.stopIntentId,request.wakeIntentId,
        request.safetyStop.intentId,request.safetyStop.requestId,safetySourceSha256])).rows[0]!.matches,"owner_recovery_safety_stop_changed");
  }
  check([request.stopIntentId,request.wakeIntentId].includes(workspace.accepted_lifecycle_intent_id),"owner_recovery_accepted_intent_changed");
  check(!(await tx.query(`SELECT 1 FROM cloud_workspace_generation_transitions WHERE workspace_id=$1 AND org_id=$2
    AND state IN ('draining','provisioning','setting_up','rolling_back') UNION ALL
    SELECT 1 FROM cloud_workspace_final_save_dispatches WHERE workspace_id=$1 AND org_id=$2 AND settled_at IS NULL UNION ALL
    SELECT 1 FROM cloud_workspace_setup_runs WHERE workspace_id=$1 AND org_id=$2 AND state='running'
      AND lease_expires_at>clock_timestamp()`, [request.workspaceId,request.organizationId])).rowCount,"owner_recovery_work_in_flight");
  const engine = (await tx.query(`SELECT engine.id FROM cloud_workspace_engine_instances engine
    JOIN cloud_workspace_final_save_recoveries held ON held.lifecycle_intent_id=$5
    JOIN cloud_agent_boot_bindings boot ON boot.engine_instance_id=engine.id AND boot.workspace_id=engine.workspace_id AND boot.org_id=engine.org_id
    WHERE engine.id=$1 AND engine.workspace_id=$2 AND engine.org_id=$3 AND engine.generation=$4
      AND engine.registered_at=held.registered_at AND engine.heartbeat_token_hash=$6 AND engine.runtime_id=$7 AND engine.runtime_boot_id=$8
      AND boot.boot_id=$8 AND boot.writer_epoch=$9 AND boot.funding_owner_user_id=$10 AND boot.funding_owner_epoch=$11
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_engine_instances newer WHERE newer.workspace_id=engine.workspace_id
        AND newer.org_id=engine.org_id AND newer.generation=engine.generation AND newer.enrollment_order>engine.enrollment_order)
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_engine_instances live WHERE live.workspace_id=engine.workspace_id
        AND live.org_id=engine.org_id AND live.generation=engine.generation AND live.state IN ('starting','ready')
        AND live.revoked_at IS NULL AND live.lease_expires_at>clock_timestamp()) FOR SHARE OF engine,boot`,
  [recovery.engine_instance_id,request.workspaceId,request.organizationId,request.sourceGeneration,request.recoveryId,
    recovery.registration_token_sha256,recovery.runtime_id,recovery.boot_id,recovery.writer_epoch,recovery.funding_owner_user_id,recovery.funding_owner_epoch])).rows[0];
  check(engine,"owner_recovery_source_changed_or_live");
  check((await tx.query(`SELECT 1 FROM managed_compute_allocation_leases lease WHERE lease.id=$1
    AND lease.workspace_id=$2 AND lease.org_id=$3 AND lease.generation=$4 AND lease.provider_resource_id=$5
    AND NOT EXISTS (SELECT 1 FROM managed_compute_allocation_leases newer WHERE newer.workspace_id=lease.workspace_id
      AND newer.org_id=lease.org_id AND newer.provider_resource_id=lease.provider_resource_id
      AND (newer.created_at,newer.id)>(lease.created_at,lease.id))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_allocation_owners owner WHERE owner.workspace_id=lease.workspace_id
      AND owner.org_id=lease.org_id AND owner.provider_resource_id=lease.provider_resource_id
      AND (owner.current_generation<>$4 OR owner.allocation_lease_id<>lease.id))`,
  [source.data.allocationLeaseId,request.workspaceId,request.organizationId,request.sourceGeneration,request.providerResourceId])).rowCount===1,
  "owner_recovery_allocation_changed");
  const loss = (await tx.query(`SELECT loss.id,loss.inventory_sha256,loss.provider_account,
      loss.inventory_observed_at BETWEEN clock_timestamp()-interval '15 minutes' AND clock_timestamp()
        AND loss.lookup_observed_at BETWEEN clock_timestamp()-interval '15 minutes' AND clock_timestamp() AS fresh
    FROM cloud_workspace_provider_loss_attestations loss
    JOIN cloud_workspace_provider_operations operation ON operation.provider=loss.provider AND operation.account_scope=loss.account_scope
      AND operation.workspace_id=loss.workspace_id AND operation.generation=loss.generation AND operation.resource_id=loss.resource_id
    WHERE loss.id=$1 AND loss.provider='boat' AND loss.account_scope=$2 AND loss.workspace_id=$3 AND loss.generation=$4
      AND loss.resource_id=$5 AND operation.org_id=$6 AND operation.lost_at IS NOT NULL
      AND cloud_provider_allocation_lost($3,$4,$6,$5) FOR SHARE OF loss,operation`,
  [request.providerLossAttestationId,request.providerAccountScope,request.workspaceId,request.sourceGeneration,
    request.providerResourceId,request.organizationId])).rows[0];
  check(loss,"owner_recovery_loss_unconfirmed");
  let lossObservation: { inventorySha256:Buffer; inventoryObservedAt:Date; lookupObservedAt:Date; providerAccount:string; inventoryResourceCount:number } | null=null;
  if (request.lossRecheck) {
    check(request.lossRecheck.providerAccount===loss.provider_account,"owner_recovery_loss_account_changed");
    check(options.lossEvidence,"owner_recovery_loss_evidence_required");
    const {inventory,lookup}=options.lossEvidence;
    check(inventory.providerAccount===loss.provider_account && lookup.resourceId===request.providerResourceId && lookup.notFound &&
      inventory.resources.length<=100_000 && inventory.resources.every(row=>BOAT_RESOURCE_ID_PATTERN.test(row.id)) &&
      !inventory.resources.some(row=>row.id===request.providerResourceId),"owner_recovery_loss_unconfirmed");
    const now=(await tx.query<{ now:Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.getTime();
    check([inventory.observedAt,lookup.observedAt].every(at=>Number.isFinite(at.getTime()) &&
      now-at.getTime()>=0 && now-at.getTime()<=15*60_000),"owner_recovery_loss_evidence_expired");
    await assertInventoryAccount(tx,request.providerAccountScope,inventory);
    await assertInventoryComplete(tx,request.providerAccountScope,[...new Set(inventory.resources.map(row=>row.id))],request.providerResourceId);
    lossObservation={inventorySha256:inventoryDigest(request.providerAccountScope,inventory),inventoryObservedAt:inventory.observedAt,
      lookupObservedAt:lookup.observedAt,providerAccount:inventory.providerAccount,inventoryResourceCount:new Set(inventory.resources.map(row=>row.id)).size};
  } else check(loss.fresh,"owner_recovery_loss_unconfirmed");
  const point = await requireCloudRecoveryPoint(tx,request);
  check(point.integrity_sha256.toString("hex")===request.checkpointSha256 && Number(point.content_revision)===request.checkpointContentRevision &&
    Number(point.record_revision)===request.checkpointRecordRevision && point.durable_at.getTime()===Date.parse(request.checkpointAt),
  "owner_recovery_checkpoint_changed");
  const selected = await selectCheckpointComputerSource(tx,{...request,config:options.config,
    qualificationMode:options.config.runtime?.qualificationMode??cloudRuntimeQualificationMode()});
  check(selected.computer.buildId===request.computerBuildId && selected.computer.configId===request.computerConfigId &&
    selected.runtime.runtimeId===request.runtimeId,"owner_recovery_computer_changed");
  const candidateGeneration = (await tx.query<{ generation:number }>(
    "SELECT max(generation)::integer+1 AS generation FROM cloud_workspace_generations WHERE workspace_id=$1 AND org_id=$2",
  [request.workspaceId,request.organizationId])).rows[0]!.generation;
  // Retry counters and heartbeat/deadline passage are not new authority. Bind
  // the immutable source plus current admission revisions, never raw tokens.
  const snapshot = { source:source.data,authorization,registrationTokenSha256:recovery.registration_token_sha256.toString("hex"),
    attemptOrdinal:recovery.attempt_ordinal,authorityEpoch:String(workspace.authority_epoch),billingEpoch:workspace.current_billing_epoch,
    owner:workspace.owner_user_id,acceptedIntent:workspace.accepted_lifecycle_intent_id,candidateGeneration,
    lossInventorySha256:loss.inventory_sha256.toString("hex"),runtime:selected.runtime,computer:selected.computer,
    stopDigest:stop.request_sha256.toString("hex"),wakeDigest:wake.request_sha256.toString("hex"),
    ...(request.safetyStop ? {safetySourceSha256:safetySourceSha256!.toString("hex"),
      safetyStopDigest:intents.find(row=>row.id===request.safetyStop!.intentId)!.request_sha256.toString("hex")} : {}) };
  // Fresh provider observations necessarily change between plan and execute.
  // Approval binds their requested account/target, not a movable timestamp;
  // execute independently checks freshness and retains that exact observation.
  return { sourceSha256,candidateGeneration,snapshot,safetySourceSha256,lossObservation };
}

export async function manageCloudOwnerCheckpointRecovery(
  pool: pg.Pool,
  supplied: CloudOwnerCheckpointRecoveryRequest,
  options: Options,
): Promise<CloudOwnerCheckpointRecoveryResult> {
  const parsed = CloudOwnerCheckpointRecoverySchema.safeParse(supplied);
  check(parsed.success,"owner_recovery_request_invalid");
  const request=parsed.data, target=ownerRecoveryTarget(options.databaseUrl,request.channel);
  const requestDigest=ownerRecoveryDigest({target,request});
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query("SELECT set_config('app.system','on',true)");
    check((await client.query(`SELECT 1 FROM pg_class WHERE oid='public.cloud_workspace_owner_discard_receipts'::regclass
      AND pg_get_userbyid(relowner)=current_user AND current_user<>'zeros_app'`)).rowCount===1,"owner_recovery_database_owner_required");
    check((await client.query(`SELECT 1 FROM users WHERE id=$1 AND auth_status='active' AND deleted_at IS NULL
      AND staff_role='platform_owner' FOR SHARE`,[request.operatorUserId])).rowCount===1,"owner_recovery_operator_required");
    check((await client.query("SELECT 1 FROM organizations WHERE id=$1 AND lower(slug::text)=$2 FOR UPDATE",
      [request.organizationId,request.expectedOrganizationSlug])).rowCount===1,"owner_recovery_organization_changed");
    await client.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE",[request.workspaceId,request.organizationId]);
    if (request.retry) return await manageCloudOwnerCheckpointRetry(client,request,options,target,requestDigest);
    const previous = (await client.query(`SELECT receipt.*,transition.state AS transition_state FROM cloud_workspace_owner_discard_receipts receipt
      LEFT JOIN cloud_workspace_generation_transitions transition ON transition.id=receipt.transition_id
      WHERE receipt.id=$1 OR (receipt.workspace_id=$2 AND receipt.org_id=$3 AND receipt.source_generation=$4)`,
    [request.operationId,request.workspaceId,request.organizationId,request.sourceGeneration])).rows[0];
    if (previous) {
      check(previous.id===request.operationId && previous.request_sha256.equals(requestDigest),"owner_recovery_replay_mismatch");
      const approval=`owner-checkpoint-recovery:v1:${previous.plan_sha256.toString("hex")}`;
      check(!options.execute || options.approval===approval,"owner_recovery_approval_mismatch");
      await client.query("ROLLBACK");
      return {state:"unchanged",approval,receiptId:previous.id,transitionId:previous.transition_id,
        transitionState:previous.transition_state,candidateGeneration:previous.candidate_generation};
    }
    const plan=await readPlan(client,request,options);
    const planDigest=ownerRecoveryDigest({requestSha256:requestDigest.toString("hex"),snapshot:plan.snapshot});
    const approval=`owner-checkpoint-recovery:v1:${planDigest.toString("hex")}`;
    if (!options.execute) {
      await client.query("ROLLBACK");
      return {state:"planned",approval,receiptId:request.operationId,transitionId:null,transitionState:null,candidateGeneration:plan.candidateGeneration};
    }
    check(options.approval===approval,"owner_recovery_approval_mismatch");
    if (request.safetyStop) await client.query(`UPDATE workspace_checkpoint_requests
      SET state='cancelled',completed_at=clock_timestamp(),error_code='owner_discarded'
      WHERE id=$1 AND state='queued' AND delivery_count=0 AND last_delivered_at IS NULL`,[request.safetyStop.requestId]);
    const transitionId=randomUUID();
    await client.query(`INSERT INTO cloud_workspace_owner_discard_receipts
      (id,workspace_id,org_id,source_generation,stop_intent_id,wake_intent_id,request_id,retirement_id,custody_id,source_sha256,
       provider_loss_attestation_id,provider_resource_id,checkpoint_id,checkpoint_sha256,checkpoint_content_revision,checkpoint_record_revision,
       checkpoint_at,computer_build_id,computer_config_id,runtime_id,owner_user_id,operator_user_id,owner_approval_reference,reason,
       request_sha256,plan_sha256,target_fingerprint,database_principal,transition_id,candidate_generation,
       safety_stop_intent_id,safety_request_id,safety_source_sha256,
       loss_inventory_sha256,loss_inventory_observed_at,loss_lookup_observed_at,loss_provider_account,loss_inventory_resource_count)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
        (SELECT durable_at FROM workspace_checkpoints WHERE id=$13 AND date_trunc('milliseconds',durable_at)=$17::timestamptz),
        $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,current_user,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37)`,
    [request.operationId,request.workspaceId,request.organizationId,request.sourceGeneration,request.stopIntentId,request.wakeIntentId,
      request.requestId,request.retirementId,request.custodyId,plan.sourceSha256,request.providerLossAttestationId,request.providerResourceId,
      request.checkpointId,Buffer.from(request.checkpointSha256,"hex"),request.checkpointContentRevision,request.checkpointRecordRevision,request.checkpointAt,
      request.computerBuildId,request.computerConfigId,request.runtimeId,request.ownerUserId,request.operatorUserId,request.ownerApprovalReference,request.reason,
      requestDigest,planDigest,target,transitionId,plan.candidateGeneration,
      request.safetyStop?.intentId??null,request.safetyStop?.requestId??null,plan.safetySourceSha256,
      plan.lossObservation?.inventorySha256??null,plan.lossObservation?.inventoryObservedAt??null,
      plan.lossObservation?.lookupObservedAt??null,plan.lossObservation?.providerAccount??null,plan.lossObservation?.inventoryResourceCount??null]);
    await client.query(`UPDATE cloud_workspace_final_save_recoveries SET state='discarded',next_attempt_at='infinity'::timestamptz
      WHERE lifecycle_intent_id=ANY($1::uuid[])`,[[request.stopIntentId,...(request.safetyStop ? [request.safetyStop.intentId] : [])]]);
    await client.query(`UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=ANY($1::uuid[])`,[[request.stopIntentId,request.wakeIntentId,...(request.safetyStop ? [request.safetyStop.intentId] : [])]]);
    await client.query("UPDATE cloud_workspaces SET accepted_lifecycle_intent_id=NULL WHERE id=$1 AND org_id=$2",[request.workspaceId,request.organizationId]);
    await createCloudRecoveryTransition(client,{...request,actorUserId:request.ownerUserId,workosEnabled:options.workosEnabled,
      config:options.config,idempotencyKey:`owner-recovery.${request.operationId}`,requestDigest,
      allowDataLoss:true,drainIntentId:request.stopIntentId,ownerDiscardReceiptId:request.operationId});
    // This fact comes from exact loss identity plus fresh authenticated observations. It is
    // not inferred from a timeout, a missing row, or the owner's acknowledgement.
    check((await client.query(`UPDATE cloud_workspace_provider_bindings SET observed_state='deleted',provider_target=NULL,
      deletion_verified_at=clock_timestamp(),last_observed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND provider='boat' AND provider_resource_id=$4
        AND cloud_provider_allocation_lost($1,$3,$2,$4)`,
    [request.workspaceId,request.organizationId,request.sourceGeneration,request.providerResourceId])).rowCount===1,"owner_recovery_loss_changed");
    await audit(client,request.organizationId,request.operatorUserId,"cloud_workspace.owner_discard_checkpoint_recovery",{
      workspaceId:request.workspaceId,receiptId:request.operationId,sourceGeneration:request.sourceGeneration,
      candidateGeneration:plan.candidateGeneration,transitionId,stopIntentId:request.stopIntentId,wakeIntentId:request.wakeIntentId,
      ...(request.safetyStop ? {safetyStopIntentId:request.safetyStop.intentId,safetyRequestId:request.safetyStop.requestId} : {}),
      lossRechecked:plan.lossObservation!==null,
      checkpointId:request.checkpointId,reasonCode:"owner_accepted_unsaved_loss",reasonSha256:ownerRecoveryDigest(request.reason).toString("hex")});
    await client.query("COMMIT");
    return {state:"restoring",approval,receiptId:request.operationId,transitionId,transitionState:"provisioning",candidateGeneration:plan.candidateGeneration};
  } catch (error) {
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  } finally { client.release(); }
}

/** Provider reads happen after the failed read-only transaction has released
 * its locks. Committed replay never performs another provider lookup. */
export async function manageCloudOwnerCheckpointRecoveryWithEvidence(
  pool: pg.Pool, request: CloudOwnerCheckpointRecoveryRequest, options: Options,
  readEvidence: () => Promise<OwnerRecoveryLossEvidence>,
): Promise<CloudOwnerCheckpointRecoveryResult> {
  try { return await manageCloudOwnerCheckpointRecovery(pool,request,options); }
  catch (error) {
    if (!(error instanceof CloudOwnerCheckpointRecoveryError) || error.code!=="owner_recovery_loss_evidence_required") throw error;
  }
  const lossEvidence=await readEvidence();
  return manageCloudOwnerCheckpointRecovery(pool,request,{...options,lossEvidence});
}

/** Nonblocking same-FD validation avoids FIFO/symlink hangs before a plan. */
export async function readOwnerCheckpointRecoveryRequest(filename: string): Promise<CloudOwnerCheckpointRecoveryRequest> {
  const file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=await file.stat();
    check(stat.isFile() && stat.uid===process.getuid?.() && (stat.mode&0o777)===0o600 && stat.size>0 && stat.size<=16_384,
      "owner_recovery_request_file_invalid");
    const bytes=Buffer.alloc(16_385);
    const {bytesRead}=await file.read(bytes,0,bytes.length,0);
    check(bytesRead===stat.size,"owner_recovery_request_file_changed");
    let value:unknown;
    try { value=JSON.parse(bytes.subarray(0,bytesRead).toString("utf8")); }
    catch { throw new CloudOwnerCheckpointRecoveryError("owner_recovery_request_invalid"); }
    const parsed=CloudOwnerCheckpointRecoverySchema.safeParse(value);
    check(parsed.success,"owner_recovery_request_invalid");
    return parsed.data;
  } finally { await file.close(); }
}

async function runCli(): Promise<void> {
  check(process.argv.slice(2).every(value=>value==="--execute"),"owner_recovery_argument_invalid");
  const filename=process.env.CONTROL_PLANE_OWNER_RECOVERY_REQUEST_FILE;
  check(filename,"owner_recovery_request_file_required");
  const request=await readOwnerCheckpointRecoveryRequest(filename);
  const config=loadConfig();
  check(config.cloudWorkspaces && config.deploymentChannel===request.channel,"owner_recovery_channel_mismatch");
  const pool=createMigrationPool(config.databaseUrl,{maxConnections:1});
  try {
    const result=await manageCloudOwnerCheckpointRecoveryWithEvidence(pool,request,{databaseUrl:config.databaseUrl,config:config.cloudWorkspaces,
      workosEnabled:config.auth.provider==="workos",execute:process.argv.includes("--execute"),approval:process.env.CONTROL_PLANE_OWNER_RECOVERY_APPROVAL},async()=>{
      const apiKey=process.env.BOAT_API_KEY?.trim();
      check(apiKey,"owner_recovery_provider_key_required");
      const boat=new BoatApiClient({apiKey,timeoutMs:30_000});
      return {inventory:await readBoatInventory(pool,boat,request.providerAccountScope),
        lookup:await lookupBoatResource(boat,request.providerResourceId,await databaseClock(pool))};
    });
    console.log(JSON.stringify(result));
  } finally { await pool.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
  runCli().catch(error=>{
    console.error(JSON.stringify({state:"refused",code:error instanceof CloudOwnerCheckpointRecoveryError ? error.code : "owner_recovery_failed"}));
    process.exitCode=1;
  });
}
