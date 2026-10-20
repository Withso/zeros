import { randomUUID } from "node:crypto";
import type { Tx } from "../db.js";
import { audit } from "../audit.js";
import type { CloudOwnerCheckpointRecoveryResult, OwnerCheckpointRecoveryOptions } from "../manage-cloud-owner-checkpoint-recovery.js";
import { ownerRecoveryDigest, requireOwnerRecovery as check, type CloudOwnerCheckpointRecoveryRequest } from "../cloud-owner-checkpoint-recovery-contract.js";
import { createCloudRecoveryTransition, requireCloudRecoveryAdmission } from "./automatic-recovery.js";
import { selectCheckpointComputerSource } from "./checkpoint-computer-source.js";
import { cloudRuntimeQualificationMode } from "./runtime-config.js";

/** Called only inside the manage CLI's database-owner transaction, after its
 * operator, organization and workspace locks. This spends no new discard and
 * never reuses the original request as implicit permission to allocate. */
export async function manageCloudOwnerCheckpointRetry(tx: Tx, request: CloudOwnerCheckpointRecoveryRequest,
  options: OwnerCheckpointRecoveryOptions, target: string, requestDigest: Buffer): Promise<CloudOwnerCheckpointRecoveryResult> {
  const retry=request.retry!;
  const previous=(await tx.query(`SELECT retry.*,transition.state AS transition_state FROM cloud_workspace_owner_recovery_retries retry
    LEFT JOIN cloud_workspace_generation_transitions transition ON transition.id=retry.transition_id
    WHERE retry.id=$1 OR retry.failed_transition_id=$2`,[request.operationId,retry.failedTransitionId])).rows[0];
  if(previous) {
    check(previous.id===request.operationId && previous.request_sha256.equals(requestDigest),"owner_recovery_replay_mismatch");
    const approval=`owner-checkpoint-retry:v1:${previous.plan_sha256.toString("hex")}`;
    check(!options.execute || options.approval===approval,"owner_recovery_approval_mismatch");
    await tx.query("ROLLBACK");
    return {state:"unchanged",approval,receiptId:previous.id,transitionId:previous.transition_id,
      transitionState:previous.transition_state,candidateGeneration:previous.candidate_generation};
  }
  const owner=(await tx.query(`SELECT receipt.*,loss.account_scope,loss.provider_account
    FROM cloud_workspace_owner_discard_receipts receipt
    JOIN cloud_workspace_provider_loss_attestations loss ON loss.id=receipt.provider_loss_attestation_id
    WHERE receipt.id=$1 FOR SHARE OF receipt,loss`,[retry.ownerDiscardReceiptId])).rows[0];
  check(owner && owner.workspace_id===request.workspaceId && owner.org_id===request.organizationId && owner.owner_user_id===request.ownerUserId &&
    owner.source_generation===request.sourceGeneration && owner.stop_intent_id===request.stopIntentId && owner.wake_intent_id===request.wakeIntentId &&
    owner.request_id===request.requestId && owner.retirement_id===request.retirementId && owner.custody_id===request.custodyId &&
    owner.provider_loss_attestation_id===request.providerLossAttestationId && owner.provider_resource_id===request.providerResourceId &&
    owner.account_scope===request.providerAccountScope && (!request.lossRecheck || owner.provider_account===request.lossRecheck.providerAccount) &&
    owner.checkpoint_id===request.checkpointId && owner.checkpoint_sha256.toString("hex")===request.checkpointSha256 &&
    Number(owner.checkpoint_content_revision)===request.checkpointContentRevision && Number(owner.checkpoint_record_revision)===request.checkpointRecordRevision &&
    owner.checkpoint_at.getTime()===Date.parse(request.checkpointAt) && owner.transition_id===retry.failedTransitionId &&
    owner.candidate_generation===retry.failedCandidateGeneration && (owner.safety_stop_intent_id??null)===(request.safetyStop?.intentId??null) &&
    (owner.safety_request_id??null)===(request.safetyStop?.requestId??null),"owner_recovery_retry_source_changed");
  check((await tx.query<{ready:boolean}>("SELECT cloud_owner_recovery_retry_ready($1,$2,$3,$4) AS ready",
    [owner.id,retry.failedTransitionId,retry.cleanupStopIntentId,retry.cleanupDeleteIntentId])).rows[0]!.ready,"owner_recovery_retry_cleanup_pending");
  check(request.runtimeId!==owner.runtime_id,"owner_recovery_retry_runtime_unchanged");
  const admission=await requireCloudRecoveryAdmission(tx,{...request,actorUserId:request.ownerUserId,workosEnabled:options.workosEnabled,allowDataLoss:true});
  const selected=await selectCheckpointComputerSource(tx,{...request,config:options.config,
    qualificationMode:options.config.runtime?.qualificationMode??cloudRuntimeQualificationMode()});
  check(selected.computer.buildId===request.computerBuildId && selected.computer.configId===request.computerConfigId &&
    selected.runtime.runtimeId===request.runtimeId,"owner_recovery_computer_changed");
  const candidateGeneration=(await tx.query<{generation:number}>(
    "SELECT max(generation)::integer+1 AS generation FROM cloud_workspace_generations WHERE workspace_id=$1 AND org_id=$2",
    [request.workspaceId,request.organizationId])).rows[0]!.generation;
  const authority=(await tx.query(`SELECT authority_epoch,current_billing_epoch,agent_funding_owner_epoch,accepted_lifecycle_intent_id
    FROM cloud_workspaces WHERE id=$1 AND org_id=$2`,[request.workspaceId,request.organizationId])).rows[0];
  const planDigest=ownerRecoveryDigest({requestSha256:requestDigest.toString("hex"),snapshot:{authorization:admission.authorization,
    authority,candidateGeneration,computer:selected.computer,runtime:selected.runtime}});
  const approval=`owner-checkpoint-retry:v1:${planDigest.toString("hex")}`;
  if(!options.execute) {
    await tx.query("ROLLBACK");
    return {state:"planned",approval,receiptId:request.operationId,transitionId:null,transitionState:null,candidateGeneration};
  }
  check(options.approval===approval,"owner_recovery_approval_mismatch");
  const transitionId=randomUUID();
  await tx.query(`INSERT INTO cloud_workspace_owner_recovery_retries
    (id,owner_discard_receipt_id,workspace_id,org_id,source_generation,failed_transition_id,failed_candidate_generation,
     cleanup_stop_intent_id,cleanup_delete_intent_id,transition_id,candidate_generation,checkpoint_id,computer_build_id,computer_config_id,
     runtime_id,owner_user_id,operator_user_id,owner_approval_reference,reason,request_sha256,plan_sha256,target_fingerprint,database_principal)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,current_user)`,
  [request.operationId,owner.id,request.workspaceId,request.organizationId,request.sourceGeneration,retry.failedTransitionId,retry.failedCandidateGeneration,
    retry.cleanupStopIntentId,retry.cleanupDeleteIntentId,transitionId,candidateGeneration,request.checkpointId,request.computerBuildId,
    request.computerConfigId,request.runtimeId,request.ownerUserId,request.operatorUserId,request.ownerApprovalReference,request.reason,requestDigest,planDigest,target]);
  await createCloudRecoveryTransition(tx,{...request,actorUserId:request.ownerUserId,workosEnabled:options.workosEnabled,config:options.config,
    idempotencyKey:`owner-retry.${request.operationId}`,requestDigest,allowDataLoss:true,ownerDiscardReceiptId:owner.id,ownerRecoveryRetryId:request.operationId});
  await audit(tx,request.organizationId,request.operatorUserId,"cloud_workspace.owner_checkpoint_retry",{workspaceId:request.workspaceId,
    receiptId:request.operationId,ownerDiscardReceiptId:owner.id,failedTransitionId:retry.failedTransitionId,transitionId,
    sourceGeneration:request.sourceGeneration,candidateGeneration,checkpointId:request.checkpointId,
    reasonCode:"never_started_candidate_retired",reasonSha256:ownerRecoveryDigest(request.reason).toString("hex")});
  await tx.query("COMMIT");
  return {state:"restoring",approval,receiptId:request.operationId,transitionId,transitionState:"provisioning",candidateGeneration};
}
