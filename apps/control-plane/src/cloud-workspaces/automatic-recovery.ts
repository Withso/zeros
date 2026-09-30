import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import type { CloudWorkspaceBackendConfig, CloudWorkspaceProvisioningProfile } from "../config.js";
import { authorizeCloudWorkspaceOperation } from "./authorization.js";
import { authorizeCloudWorkspaceActor } from "./actors.js";
import { refreshCloudWorkspaceBillingEpoch } from "./paid-authority.js";
import { cloudWorkspaceProvisioningProfile } from "./provisioning-profile.js";
import { resolveComputerImage } from "./computer-image.js";
import { loadGenerationCloudProviderConnection } from "./provider-connections.js";
import { persistCloudWorkspaceSetupSecrets, persistDatabaseCloudWorkspaceSettings, resolveDatabaseCloudWorkspaceSettings } from "./settings.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";
import type { CloudWorkspaceSetupExecution } from "./setup-worker.js";
import { parseSetupDiagnostic } from "./cloud-diagnostics.js";
import { advanceCloudWorkspaceGenerationTransitionAfterDrain, cancelCloudWorkspaceGenerationTransition, rollbackCloudWorkspaceGenerationTransition } from "./generation-transitions.js";

export type QuotaRow = {
  max_workspaces: number;
  max_running_workspaces: number;
  max_cpu_millicores: number;
  max_memory_mib: number;
  max_storage_mib: number;
};

export async function loadQuota(tx: Tx, orgId: string): Promise<QuotaRow> {
  const result = await tx.query<QuotaRow>(
    `SELECT max_workspaces, max_running_workspaces, max_cpu_millicores,
            max_memory_mib, max_storage_mib
     FROM cloud_workspace_quotas WHERE org_id = $1`,
    [orgId],
  );
  const quota = result.rows[0];
  if (!quota) {
    throw new HttpError(
      409,
      "cloud_quota_not_configured",
      "Cloud workspace quota is not configured for this organization",
    );
  }
  return quota;
}

export type UsageRow = {
  workspaces: string | number;
  running: string | number;
  cpu_millicores: string | number;
  memory_mib: string | number;
  storage_mib: string | number;
};

export async function loadUsage(tx: Tx, orgId: string): Promise<UsageRow> {
  // A candidate reserves its full shape before provider allocation. Any known
  // provider resource retains disk allocation until deletion is verified.
  const result = await tx.query<UsageRow>(
    `WITH workspace_usage AS (
       SELECT count(*) AS workspaces,
              count(*) FILTER (WHERE desired_state = 'running') AS running
       FROM cloud_workspaces
       WHERE org_id = $1 AND status <> 'deleted'
     ), generation_allocation AS (
       SELECT generation.cpu_millicores, generation.memory_mib,
              generation.storage_mib, workspace.desired_state,
              (
                workspace.status <> 'deleted'
                AND generation.generation = workspace.current_generation
              ) AS current_reserved,
              (
                workspace.status <> 'deleted'
                AND generation.generation <> workspace.current_generation
                AND generation.retired_at IS NULL
                AND transition.id IS NOT NULL
              ) AS candidate_reserved,
              (
                binding.provider_resource_id IS NOT NULL
                AND binding.deletion_verified_at IS NULL
              ) AS provider_storage_allocated
       FROM cloud_workspaces workspace
       JOIN cloud_workspace_generations generation
         ON generation.workspace_id = workspace.id
        AND generation.org_id = workspace.org_id
       LEFT JOIN cloud_workspace_provider_bindings binding
         ON binding.workspace_id = generation.workspace_id
        AND binding.generation = generation.generation
        AND binding.org_id = generation.org_id
       LEFT JOIN cloud_workspace_generation_transitions transition
         ON transition.workspace_id = generation.workspace_id
        AND transition.org_id = generation.org_id
        AND transition.candidate_generation = generation.generation
        AND transition.state IN (
          'draining', 'provisioning', 'setting_up', 'rolling_back'
        )
       WHERE workspace.org_id = $1
     ), generation_usage AS (
       SELECT coalesce(sum(cpu_millicores) FILTER (
                WHERE (current_reserved AND desired_state = 'running')
                   OR candidate_reserved
              ), 0) AS cpu_millicores,
              coalesce(sum(memory_mib) FILTER (
                WHERE (current_reserved AND desired_state = 'running')
                   OR candidate_reserved
              ), 0) AS memory_mib,
              coalesce(sum(storage_mib) FILTER (
                WHERE current_reserved OR candidate_reserved
                   OR provider_storage_allocated
              ), 0) AS storage_mib
       FROM generation_allocation
     )
     SELECT workspace_usage.workspaces, workspace_usage.running,
            generation_usage.cpu_millicores, generation_usage.memory_mib,
            generation_usage.storage_mib
     FROM workspace_usage CROSS JOIN generation_usage`,
    [orgId],
  );
  return result.rows[0]!;
}

export function assertGenerationReplacementQuota(
  quota: QuotaRow,
  usage: UsageRow,
  resources: {
    cpuMillicores: number;
    memoryMiB: number;
    storageMiB: number;
  },
): void {
  const exceeded =
    Number(usage.cpu_millicores) + resources.cpuMillicores >
      quota.max_cpu_millicores ||
    Number(usage.memory_mib) + resources.memoryMiB > quota.max_memory_mib ||
    Number(usage.storage_mib) + resources.storageMiB > quota.max_storage_mib;
  if (exceeded) {
    throw new HttpError(
      409,
      "cloud_replacement_headroom_exceeded",
      "Cloud workspace quota does not have safe replacement headroom",
    );
  }
}


type RecoveryScope = { workspaceId: string; organizationId: string; sourceGeneration: number; checkpointId: string };
type RecoveryPoint = { id: string; integrity_sha256: Buffer; content_revision: string; record_revision: string; durable_at: Date; lossless: boolean };

// SQL fragments take only fixed caller expressions, never request data. Keep
// the desktop acknowledgement and worker's lossless decision identical.
export function cloudRecoveryPointLosslessSql(sourceGenerationSql: string): string {
  return `(checkpoint.generation=${sourceGenerationSql} AND checkpoint.content_revision=head.current_revision
    AND checkpoint.record_revision>=coalesce((SELECT current_revision FROM workspace_record_heads
      WHERE workspace_id=checkpoint.workspace_id AND org_id=checkpoint.org_id),0)
    AND EXISTS (SELECT 1 FROM workspace_checkpoint_requests request
      WHERE request.workspace_id=checkpoint.workspace_id AND request.org_id=checkpoint.org_id
        AND request.generation=${sourceGenerationSql} AND request.checkpoint_id=checkpoint.id AND request.state='succeeded'
        AND request.reason IN ('before_stop','before_archive'))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_engine_instances engine
      WHERE engine.workspace_id=checkpoint.workspace_id AND engine.generation=${sourceGenerationSql}
        AND engine.registered_at>checkpoint.durable_at)
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_setup_attestations proof
      WHERE proof.workspace_id=checkpoint.workspace_id AND proof.generation=${sourceGenerationSql}
        AND proof.attested_at>checkpoint.durable_at))`;
}

/** Shared by explicit recovery and automatic recovery, under the workspace
 * lock. A periodic snapshot is usable explicitly, but never proves zero loss. */
export async function requireCloudRecoveryPoint(tx: Tx, input: RecoveryScope): Promise<RecoveryPoint> {
  const point = (await tx.query<RecoveryPoint>(`SELECT checkpoint.id,checkpoint.integrity_sha256,checkpoint.content_revision,
      checkpoint.record_revision,checkpoint.durable_at,
      ${cloudRecoveryPointLosslessSql("$4")} AS lossless
    FROM workspace_checkpoints checkpoint
    JOIN workspace_content_heads head ON head.workspace_id=checkpoint.workspace_id AND head.org_id=checkpoint.org_id
      AND head.current_checkpoint_id=checkpoint.id
    WHERE checkpoint.id=$1 AND checkpoint.workspace_id=$2 AND checkpoint.org_id=$3 AND checkpoint.state='durable'
      AND NOT EXISTS (
        SELECT 1 FROM (
          SELECT checkpoint.manifest_blob_id AS id UNION SELECT checkpoint.artifact_blob_id
          UNION SELECT entry.blob_id FROM workspace_checkpoint_entries entry WHERE entry.checkpoint_id=checkpoint.id
          UNION SELECT reference.blob_id FROM workspace_blob_references reference
            WHERE reference.reference_id=checkpoint.id::text AND reference.workspace_id=checkpoint.workspace_id
        ) needed LEFT JOIN workspace_blobs blob ON blob.id=needed.id AND blob.org_id=checkpoint.org_id
        WHERE needed.id IS NOT NULL AND (blob.id IS NULL OR blob.state<>'available')
      ) FOR SHARE OF checkpoint`, [input.checkpointId,input.workspaceId,input.organizationId,input.sourceGeneration])).rows[0];
  if (!point) throw new HttpError(404,"cloud_recovery_checkpoint_unavailable","The current durable checkpoint is unavailable");
  return point;
}

export async function requireCloudRecoveryAdmission(tx: Tx, input: RecoveryScope & { actorUserId: string; workosEnabled: boolean; allowDataLoss?: boolean }) {
  // Running-slot admission must serialize with every other organization
  // create/wake/recovery, including callers outside the HTTP route.
  await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [input.organizationId]);
  const workspace = (await tx.query<{current_generation:number;status:string;desired_state:string;deleted_at:Date|null;owner_user_id:string;team_id:string;repository_id:string}>(
    "SELECT current_generation,status,desired_state,deleted_at,owner_user_id,team_id,repository_id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE",
    [input.workspaceId,input.organizationId])).rows[0];
  if (!workspace || workspace.current_generation!==input.sourceGeneration) throw new HttpError(409,"cloud_generation_changed","Cloud workspace generation changed before recovery");
  await authorizeCloudWorkspaceActor(tx,{...input,capability:"manage"});
  if (input.actorUserId!==workspace.owner_user_id) throw new HttpError(403,"cloud_workspace_owner_required","Only the workspace owner can recover this workspace");
  const authorization = await authorizeCloudWorkspaceOperation(tx,{...input,teamId:workspace.team_id,billingOwnerUserId:workspace.owner_user_id,requireWorkspaceOwner:true});
  await refreshCloudWorkspaceBillingEpoch(tx,{...input,authorization});
  const expired = (await tx.query(`SELECT 1 FROM cloud_workspace_engine_instances WHERE workspace_id=$1 AND generation=$2 AND lease_expires_at<=now()
    AND NOT EXISTS(SELECT 1 FROM cloud_workspace_engine_instances live WHERE live.workspace_id=$1 AND live.generation=$2
      AND live.state IN ('starting','ready') AND live.revoked_at IS NULL AND live.lease_expires_at>now())`,[input.workspaceId,input.sourceGeneration])).rowCount;
  if (workspace.deleted_at || workspace.desired_state==='deleted' || (!['failed','stopped','archived'].includes(workspace.status) && !expired))
    throw new HttpError(409,"cloud_workspace_not_stable","Recovery requires a failed or stopped workspace, or an expired engine lease");
  if ((await tx.query(`SELECT 1 FROM cloud_workspace_generation_transitions WHERE workspace_id=$1 AND org_id=$2
    AND state IN ('draining','provisioning','setting_up','rolling_back')`,[input.workspaceId,input.organizationId])).rowCount)
    throw new HttpError(409,"cloud_generation_transition_active","A cloud workspace generation transition is already active");
  if ((await tx.query(`SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND affects_workspace AND state IN ('queued','dispatching','observing')`,[input.workspaceId])).rowCount)
    throw new HttpError(409,"cloud_workspace_lifecycle_active","Cloud workspace lifecycle work must finish before recovery");
  const point = await requireCloudRecoveryPoint(tx,input);
  if (!point.lossless && input.allowDataLoss!==true) throw new HttpError(409,"recovery_acknowledgement_required","Newer unsaved work may be lost. Confirm recovery from this checkpoint");
  return {workspace,authorization,point};
}

/** The HTTP route and durable worker share authority, checkpoint, settings,
 * quota and drain-first generation admission. No worker uses a user token. */
export async function createCloudRecoveryTransition(tx: Tx, input: RecoveryScope & {
  actorUserId:string; workosEnabled:boolean; config:CloudWorkspaceBackendConfig;
  idempotencyKey:string; requestDigest:Buffer | ((profile: CloudWorkspaceProvisioningProfile) => Buffer); allowDataLoss?:boolean;
  incidentId?: string;
  drainIntentId?: string;
}) {
  const {workspace,authorization,point}=await requireCloudRecoveryAdmission(tx,input);
  const source=(await tx.query<{provider:string;spec_version:number;repository_forge:string;repository_owner:string;repository_name:string;repository_revision:string;github_installation_id:string|null}>(
    `SELECT g.provider,ss.spec_version,ss.repository_forge,ss.repository_owner,ss.repository_name,ss.repository_revision,ss.github_installation_id
     FROM cloud_workspace_generations g JOIN cloud_workspace_setup_specs ss USING(workspace_id,generation,org_id)
     WHERE g.workspace_id=$1 AND g.generation=$2 AND g.org_id=$3`,[input.workspaceId,input.sourceGeneration,input.organizationId])).rows[0];
  if(!source)throw new HttpError(404,"cloud_generation_not_qualified","Source generation is unavailable");
  const baseProfile=cloudWorkspaceProvisioningProfile(input.config,source.provider);
  const connection=await loadGenerationCloudProviderConnection(tx,{...input,generation:input.sourceGeneration});
  if(!connection||connection.provider!==baseProfile.provider)throw new HttpError(409,"cloud_provider_connection_unavailable","The cloud provider connection is unavailable");
  const profile=connection.credentialSource==='hosted'&&!authorization.isPersonal
    ? await resolveComputerImage(tx,input.organizationId,baseProfile) : baseProfile;
  if(!profile.sourceCommit)throw new HttpError(409,"recovery_image_unavailable","A qualified recovery image is unavailable");
  const quota=await loadQuota(tx,input.organizationId),usage=await loadUsage(tx,input.organizationId);
  if(workspace.desired_state!=="running"&&Number(usage.running)+1>quota.max_running_workspaces)
    throw new HttpError(409,"cloud_quota_exceeded","Cloud workspace running quota would be exceeded");
  assertGenerationReplacementQuota(quota,usage,profile);
  const digest=typeof input.requestDigest==='function'?input.requestDigest(profile):input.requestDigest;
  const generation=(await tx.query<{generation:number}>("SELECT coalesce(max(generation),0)::integer+1 AS generation FROM cloud_workspace_generations WHERE workspace_id=$1",[input.workspaceId])).rows[0]!.generation;
  const transitionId=randomUUID(),intentId=input.drainIntentId??randomUUID();
  await tx.query(`INSERT INTO cloud_workspace_generations(workspace_id,generation,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,source_commit,created_by,provider_connection_id,sandbox_class,recovery_checkpoint_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[input.workspaceId,generation,input.organizationId,profile.provider,profile.imageRef,profile.architecture,profile.cpuMillicores,profile.memoryMiB,profile.storageMiB,profile.sourceCommit,input.actorUserId,connection.id,profile.sandboxClass??null,point.id]);
  const resolved=await resolveDatabaseCloudWorkspaceSettings(tx,{organizationId:input.organizationId,repositoryId:workspace.repository_id,workspaceId:input.workspaceId,generation,actorUserId:input.actorUserId,
    isPersonal:authorization.isPersonal,secretEncryptionKeys:input.config.settingsSecretEncryptionKeys,currentSecretEncryptionKeyVersion:input.config.currentSettingsSecretEncryptionKeyVersion});
  const settings=await persistDatabaseCloudWorkspaceSettings(tx,{...input,generation,settings:resolved});
  await tx.query(`INSERT INTO cloud_workspace_setup_specs(workspace_id,generation,org_id,spec_version,repository_forge,repository_owner,repository_name,repository_revision,github_installation_id,settings_snapshot,settings_snapshot_sha256,workspace_settings_version_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,digest($10::jsonb::text,'sha256'),$11)`,[input.workspaceId,generation,input.organizationId,source.spec_version,source.repository_forge,source.repository_owner,source.repository_name,source.repository_revision,source.github_installation_id,settings.document,settings.id]);
  await persistCloudWorkspaceSetupSecrets(tx,{...input,generation,secrets:resolved.setupSecrets});
  await tx.query("INSERT INTO cloud_workspace_provider_bindings(workspace_id,generation,org_id,provider) VALUES($1,$2,$3,$4)",[input.workspaceId,generation,input.organizationId,profile.provider]);
  await retireCloudWorkspaceRuntimeAccess(tx,{...input,generation:input.sourceGeneration,reason:"generation_replacement_requested"});
  await tx.query(`UPDATE cloud_workspaces SET desired_state='running',status='stopping',authority_epoch=authority_epoch+1,version=version+1,updated_at=now(),
    last_error_code='recovery_restoring',last_error_message='Restoring workspace from saved checkpoint' WHERE id=$1 AND org_id=$2`,[input.workspaceId,input.organizationId]);
  const intent=input.drainIntentId ? (await tx.query("SELECT * FROM cloud_workspace_lifecycle_intents WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4 AND operation='stop' AND state='succeeded' AND NOT affects_workspace",[input.drainIntentId,input.workspaceId,input.organizationId,input.sourceGeneration])).rows[0] : (await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256,affects_workspace)
    VALUES($1,$2,$3,$4,$5,'stop',$6,$7,false) RETURNING *`,[intentId,input.workspaceId,input.sourceGeneration,input.organizationId,input.actorUserId,input.idempotencyKey,digest])).rows[0]!;
  const transition=(await tx.query(`INSERT INTO cloud_workspace_generation_transitions(id,workspace_id,org_id,requested_by,operation,source_generation,template_generation,candidate_generation,state,drain_intent_id)
    VALUES($1,$2,$3,$4,'recover',$5,$5,$6,'draining',$7) RETURNING *`,[transitionId,input.workspaceId,input.organizationId,input.actorUserId,input.sourceGeneration,generation,intentId])).rows[0]!;
  await tx.query("UPDATE cloud_workspace_lifecycle_intents SET generation_transition_id=$2 WHERE id=$1",[intentId,transitionId]);
  if(input.drainIntentId){
    if(!intent)throw new HttpError(409,"recovery_drain_unconfirmed","Source stop is not confirmed");
    await advanceCloudWorkspaceGenerationTransitionAfterDrain(tx,{...input,transitionId});
  }
  await tx.query(`UPDATE cloud_workspace_restore_incidents SET state='cancelled',reason='explicit_recovery_requested',updated_at=now()
    WHERE workspace_id=$1 AND id IS DISTINCT FROM $2::uuid AND state IN ('observing','queued','waiting_for_capacity','waiting_for_funding','recovery_needed')`,[input.workspaceId,input.incidentId??null]);
  // Existing checkpoint/blob references are immutable. Retention pins the source
  // throughout the bounded incident, including capacity waits and salvage.
  await tx.query("UPDATE workspace_checkpoints SET retention_until=greatest(coalesce(retention_until,now()),now()+interval '7 days') WHERE id=$1",[point.id]);
  return {intent,transition};
}

export function isRecoverableImmutableFailure(code: string): boolean {
  return code === "setup_immutable_runtime_missing" || code === "setup_immutable_inventory_invalid";
}

export function classifyCloudRestoreEvidence(code: string, diagnostic: unknown): string | null {
  const evidence = parseSetupDiagnostic(diagnostic);
  if (!evidence) return null;
  if (code === "setup_provider_bootstrap_unavailable" && evidence.phase === "bootstrap" &&
    evidence.files && Object.values(evidence.files).some(present => present === false)) return "setup_immutable_runtime_missing";
  // After repository hooks/engine admission the source can contain new work;
  // an image-launch failure cannot justify unattended rollback to a snapshot.
  if (code === "setup_image_contract_invalid" && evidence.phase === "image_preflight" &&
    [evidence.checks?.metadata, evidence.checks?.source, evidence.checks?.engine, evidence.checks?.osRelease,
      evidence.checks?.packageInventory, evidence.checks?.node].some(valid => valid === false)) return "setup_immutable_inventory_invalid";
  return null;
}

/** Accept only fixed image/bootstrap evidence, never raw output or a generic
 * helper failure. The caller has verified the exact setup claim and fence. */
export async function recordCloudRestoreEvidence(tx: Tx, setup: CloudWorkspaceSetupExecution, code: string): Promise<void> {
  if (setup.provider.name!=="boat" || !isRecoverableImmutableFailure(code)) return;
  await tx.query(`INSERT INTO cloud_workspace_restore_incidents(workspace_id,org_id,source_generation,wake_intent_id,setup_run_id,
      last_successful_setup_id,provider_resource_id,owner_user_id,authority_epoch,billing_epoch,evidence_code,last_execution_fence,account_revision,organization_revision,membership_revision)
    SELECT cw.id,cw.org_id,cw.current_generation,wake.id,run.id,proof.setup_run_id,$4,cw.owner_user_id,cw.authority_epoch,cw.current_billing_epoch,$5,$6,account.auth_revision,organization.authorization_revision,member.authorization_revision
    FROM cloud_workspaces cw
    JOIN users account ON account.id=cw.owner_user_id
    JOIN organizations organization ON organization.id=cw.org_id
    JOIN organization_members member ON member.org_id=cw.org_id AND member.user_id=cw.owner_user_id
    JOIN cloud_workspace_setup_runs run ON run.id=$3 AND run.workspace_id=cw.id AND run.generation=cw.current_generation
    JOIN LATERAL (SELECT id,created_at FROM cloud_workspace_lifecycle_intents WHERE workspace_id=cw.id AND generation=cw.current_generation
      AND operation='wake' AND affects_workspace AND state='succeeded' AND created_at<=run.created_at ORDER BY created_at DESC,id DESC LIMIT 1) wake ON true
    JOIN LATERAL (SELECT setup_run_id FROM cloud_workspace_setup_attestations WHERE workspace_id=cw.id AND generation=cw.current_generation
      AND setup_run_id<>run.id AND attested_at<wake.created_at ORDER BY attested_at DESC LIMIT 1) proof ON true
    WHERE cw.id=$1 AND cw.org_id=$2 AND cw.desired_state='running' AND cw.deleted_at IS NULL
    ON CONFLICT(workspace_id,source_generation,wake_intent_id) DO UPDATE SET
      evidence_count=least(100,cloud_workspace_restore_incidents.evidence_count+1),last_execution_fence=EXCLUDED.last_execution_fence,
      evidence_code=EXCLUDED.evidence_code,updated_at=now()
    WHERE cloud_workspace_restore_incidents.setup_run_id=EXCLUDED.setup_run_id
      AND cloud_workspace_restore_incidents.last_execution_fence<EXCLUDED.last_execution_fence
      AND cloud_workspace_restore_incidents.state='observing'`,
    [setup.workspaceId,setup.organizationId,setup.setupRunId,setup.provider.resourceId,code,setup.executionFence]);
}

export async function enqueueCloudAutomaticRecovery(tx: Tx, input: {workspaceId:string;organizationId:string;generation:number;setupRunId:string}): Promise<boolean> {
  const incident=(await tx.query<{id:string;checkpoint_id:string|null;evidence_count:number;claim_count:number;epoch_current:boolean}>(`SELECT incident.id,head.current_checkpoint_id AS checkpoint_id,incident.evidence_count,run.claim_count,
      (incident.authority_epoch=cw.authority_epoch AND incident.billing_epoch=cw.current_billing_epoch AND incident.owner_user_id=cw.owner_user_id
       AND cw.desired_state='running' AND cw.current_generation=incident.source_generation
       AND incident.account_revision=(SELECT auth_revision FROM users WHERE id=cw.owner_user_id)
       AND incident.organization_revision=(SELECT authorization_revision FROM organizations WHERE id=cw.org_id)
       AND incident.membership_revision=(SELECT authorization_revision FROM organization_members WHERE org_id=cw.org_id AND user_id=cw.owner_user_id)
       AND NOT EXISTS(SELECT 1 FROM cloud_workspace_lifecycle_intents newer JOIN cloud_workspace_lifecycle_intents wake ON wake.id=incident.wake_intent_id
         WHERE newer.workspace_id=cw.id AND newer.affects_workspace AND newer.created_at>wake.created_at)) AS epoch_current
    FROM cloud_workspace_restore_incidents incident JOIN cloud_workspaces cw ON cw.id=incident.workspace_id
    JOIN cloud_workspace_setup_runs run ON run.id=incident.setup_run_id
    LEFT JOIN workspace_content_heads head ON head.workspace_id=cw.id
    WHERE incident.workspace_id=$1 AND incident.org_id=$2 AND incident.source_generation=$3 AND incident.setup_run_id=$4 AND incident.state='observing'
    FOR UPDATE OF incident`,[input.workspaceId,input.organizationId,input.generation,input.setupRunId])).rows[0];
  if(!incident || incident.evidence_count<2 || !incident.epoch_current)return false;
  let point:RecoveryPoint|null=null;
  if(incident.checkpoint_id) {
    try { point=await requireCloudRecoveryPoint(tx,{...input,sourceGeneration:input.generation,checkpointId:incident.checkpoint_id}); }
    catch(error){ if(!(error instanceof HttpError))throw error; }
  }
  const recent=(await tx.query(`SELECT 1 FROM cloud_workspace_restore_incidents WHERE workspace_id=$1 AND automatic_started_at>now()-interval '1 hour' AND id<>$2`,[input.workspaceId,incident.id])).rowCount;
  const automatic=point?.lossless===true&&!recent&&incident.evidence_count===incident.claim_count;
  await retireCloudWorkspaceRuntimeAccess(tx,{...input,reason:"setup_failed"});
  await tx.query(`UPDATE cloud_workspaces SET status='failed',authority_epoch=authority_epoch+1,version=version+1,updated_at=now(),
    last_error_code=$2,last_error_message=$3 WHERE id=$1`,[input.workspaceId,automatic?"recovery_restoring":"recovery_needed",
    automatic?"Restoring workspace from saved checkpoint":"Recovery needs attention. The source is preserved."]);
  await tx.query(`UPDATE cloud_workspace_restore_incidents SET state=$2,reason=$3,checkpoint_id=$4,checkpoint_digest=$5,content_revision=$6,record_revision=$7,checkpoint_at=$8,
    authority_epoch=(SELECT authority_epoch FROM cloud_workspaces WHERE id=$9),automatic_started_at=CASE WHEN $2='queued' THEN now() ELSE NULL END,updated_at=now()
    WHERE id=$1`,[incident.id,automatic?"queued":"recovery_needed",automatic?null:recent?"automatic_recovery_rate_limited":"lossless_checkpoint_unproven",
    point?.id??null,point?.integrity_sha256??null,point?.content_revision??null,point?.record_revision??null,point?.durable_at??null,input.workspaceId]);
  if(point)await tx.query("UPDATE workspace_checkpoints SET retention_until=greatest(coalesce(retention_until,now()),now()+interval '7 days') WHERE id=$1",[point.id]);
  if(automatic){
    const drainId=randomUUID(),key=`system:recovery-drain:${incident.id}`;
    await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,affects_workspace)
      VALUES($1,$2,$3,$4,'stop',$5,$6,false)`,[drainId,input.workspaceId,input.generation,input.organizationId,key,createHash("sha256").update(key).digest()]);
    await tx.query("UPDATE cloud_workspace_restore_incidents SET drain_intent_id=$2 WHERE id=$1",[incident.id,drainId]);
  }
  return true;
}

/** One short, serialized database step; provider I/O remains in the existing
 * fenced lifecycle reconciler. This job survives setup-worker restarts. */
export async function advanceCloudAutomaticRecovery(pool: pg.Pool, config: CloudWorkspaceBackendConfig, workosEnabled: boolean): Promise<boolean> {
  return withSystemTx(pool,async tx=>{
    const scope=(await tx.query<{workspace_id:string;org_id:string}>(`SELECT incident.workspace_id,incident.org_id FROM organizations organization
      JOIN cloud_workspace_restore_incidents incident ON incident.org_id=organization.id
      WHERE incident.state IN ('queued','waiting_for_capacity','waiting_for_funding','restoring') AND incident.next_attempt_at<=now()
      ORDER BY incident.next_attempt_at,incident.id FOR UPDATE OF organization SKIP LOCKED LIMIT 1`)).rows[0];
    if(!scope){
      // Terminal summaries expire after 30 days, in bounded batches. Never
      // remove the only quarantine evidence for a preserved source allocation.
      // This idle path holds no organization/workspace locks after row locks.
      await tx.query(`DELETE FROM cloud_workspace_restore_incidents WHERE id IN (
        SELECT incident.id FROM cloud_workspace_restore_incidents incident
        JOIN cloud_workspace_generations generation ON generation.workspace_id=incident.workspace_id AND generation.generation=incident.source_generation
        LEFT JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=generation.workspace_id AND binding.generation=generation.generation
        WHERE incident.state IN ('cancelled','succeeded') AND incident.updated_at<now()-interval '30 days'
          AND (incident.automatic_started_at IS NULL OR (generation.retired_at IS NOT NULL AND binding.deletion_verified_at IS NOT NULL))
        ORDER BY incident.updated_at,incident.id LIMIT 100 FOR UPDATE OF incident SKIP LOCKED)`);
      return false;
    }
    const workspace=(await tx.query<{current_generation:number;desired_state:string;authority_epoch:string;current_billing_epoch:string;owner_user_id:string;deleted_at:Date|null}>(
      "SELECT current_generation,desired_state,authority_epoch,current_billing_epoch,owner_user_id,deleted_at FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE SKIP LOCKED",[scope.workspace_id,scope.org_id])).rows[0];
    if(!workspace)return false;
    const job=(await tx.query<{id:string;source_generation:number;checkpoint_id:string;owner_user_id:string;authority_epoch:string;billing_epoch:string;state:string;transition_id:string|null;drain_intent_id:string|null;expired:boolean;eligible:boolean}>(
      `SELECT *,deadline_at<=now() AS expired,
         (account_revision=(SELECT auth_revision FROM users WHERE id=owner_user_id)
          AND organization_revision=(SELECT authorization_revision FROM organizations WHERE id=org_id)
          AND membership_revision=(SELECT authorization_revision FROM organization_members member WHERE member.org_id=cloud_workspace_restore_incidents.org_id AND member.user_id=owner_user_id)
          AND cloud_workspace_generation_policy_current(workspace_id,source_generation,org_id)
          AND cloud_workspace_paid_authority_live(workspace_id,owner_user_id,$2)) AS eligible
       FROM cloud_workspace_restore_incidents WHERE workspace_id=$1 AND state IN ('queued','waiting_for_capacity','waiting_for_funding','restoring')
       AND next_attempt_at<=now() ORDER BY created_at LIMIT 1 FOR UPDATE`,[scope.workspace_id,workosEnabled])).rows[0];
    if(!job)return false;
    const cancel=async(reason:string)=>{
      if(job.transition_id)await cancelCloudWorkspaceGenerationTransition(tx,{workspaceId:scope.workspace_id,organizationId:scope.org_id,reason:"paid_authority_revoked"});
      await tx.query("UPDATE cloud_workspace_restore_incidents SET state='cancelled',reason=$2,updated_at=now() WHERE id=$1",[job.id,reason]);
      if(workspace.desired_state==='running'&&!workspace.deleted_at){
        await tx.query("UPDATE cloud_workspaces SET desired_state='stopped',status='stopping',authority_epoch=authority_epoch+1,version=version+1,last_error_code='recovery_needed',updated_at=now() WHERE id=$1",[scope.workspace_id]);
        const key=`system:recovery-cancel:${job.id}`;
        await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256)
          VALUES($1,$2,$3,$4,'stop',$5,$6) ON CONFLICT DO NOTHING`,[randomUUID(),scope.workspace_id,job.source_generation,scope.org_id,key,createHash("sha256").update(key).digest()]);
      }
    };
    const transition=job.transition_id?(await tx.query<{state:string;candidate_generation:number}>("SELECT state,candidate_generation FROM cloud_workspace_generation_transitions WHERE id=$1",[job.transition_id])).rows[0]:undefined;
    if(transition?.state==='rolling_back'){
      // Repair a legacy recovery rollback even when its workspace is already
      // stopped. This only revokes authority and queues stop/cleanup work.
      await rollbackCloudWorkspaceGenerationTransition(tx,{workspaceId:scope.workspace_id,organizationId:scope.org_id,
        candidateGeneration:transition.candidate_generation,errorCode:"recovery_candidate_rejected",errorMessage:"Recovery source remains quarantined"});
      await tx.query("UPDATE cloud_workspace_restore_incidents SET state='recovery_needed',reason='recovery_candidate_rejected',updated_at=now() WHERE id=$1",[job.id]);
      return true;
    }
    if(!job.eligible||workspace.desired_state!=="running"||workspace.deleted_at||workspace.owner_user_id!==job.owner_user_id||workspace.current_billing_epoch!==job.billing_epoch){await cancel("recovery_authority_changed");return true;}
    if(job.transition_id){
      if(transition?.state==='succeeded')await tx.query("UPDATE cloud_workspace_restore_incidents SET state='succeeded',updated_at=now() WHERE id=$1",[job.id]);
      else if(!transition||['cancelled','rollback_failed','rolled_back'].includes(transition.state))await cancel("recovery_transition_ended");
      else if(job.expired){
        await rollbackCloudWorkspaceGenerationTransition(tx,{workspaceId:scope.workspace_id,organizationId:scope.org_id,
          candidateGeneration:transition.candidate_generation,errorCode:"recovery_deadline_exceeded",errorMessage:"Automatic recovery did not complete before its deadline"});
        // A stale candidate/current-generation comparison may decline rollback.
        // Do not leave a permanently due job starving ordinary setup claims.
        await tx.query("UPDATE cloud_workspace_restore_incidents SET state='recovery_needed',reason='recovery_deadline_exceeded',updated_at=now() WHERE id=$1",[job.id]);
      }
      else await tx.query("UPDATE cloud_workspace_restore_incidents SET next_attempt_at=now()+interval '30 seconds' WHERE id=$1",[job.id]);
      return true;
    }
    if(workspace.current_generation!==job.source_generation||workspace.authority_epoch!==job.authority_epoch){await cancel("recovery_authority_changed");return true;}
    if(job.expired){
      await tx.query("UPDATE cloud_workspace_restore_incidents SET state='recovery_needed',reason='recovery_deadline_exceeded',updated_at=now() WHERE id=$1",[job.id]);
      await tx.query("UPDATE cloud_workspaces SET last_error_code='recovery_needed',version=version+1,updated_at=now() WHERE id=$1",[scope.workspace_id]);return true;
    }
    if(job.drain_intent_id){
      const drain=(await tx.query<{state:string}>("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1",[job.drain_intent_id])).rows[0];
      if(drain?.state!=="succeeded"){
        if(!drain||['failed','superseded'].includes(drain.state)){
          await tx.query("UPDATE cloud_workspace_restore_incidents SET state='recovery_needed',reason='recovery_drain_unconfirmed',updated_at=now() WHERE id=$1",[job.id]);
          await tx.query("UPDATE cloud_workspaces SET last_error_code='recovery_needed',version=version+1 WHERE id=$1",[scope.workspace_id]);
        }else await tx.query("UPDATE cloud_workspace_restore_incidents SET next_attempt_at=now()+interval '5 seconds' WHERE id=$1",[job.id]);
        return true;
      }
    }
    // A savepoint keeps a refusal from partially creating a candidate or
    // refreshing authority. It never catches a database/integrity failure.
    await tx.query("SAVEPOINT recovery_admission");
    try{
      const result=await createCloudRecoveryTransition(tx,{workspaceId:scope.workspace_id,organizationId:scope.org_id,sourceGeneration:job.source_generation,
        checkpointId:job.checkpoint_id,actorUserId:job.owner_user_id,workosEnabled,config,idempotencyKey:`system:recovery:${job.id}`,
        requestDigest:createHash("sha256").update(job.id).digest(),incidentId:job.id,...(job.drain_intent_id?{drainIntentId:job.drain_intent_id}:{})});
      await tx.query("UPDATE cloud_workspace_restore_incidents SET state='restoring',transition_id=$2,next_attempt_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1",[job.id,result.transition.id]);
      await tx.query("RELEASE SAVEPOINT recovery_admission");
    }catch(error){
      if(!(error instanceof HttpError))throw error;
      await tx.query("ROLLBACK TO SAVEPOINT recovery_admission");
      const capacity=['cloud_replacement_headroom_exceeded','cloud_quota_not_configured','cloud_quota_exceeded'].includes(error.code);
      const funding=/^cloud_(?:compute|account_entitlement)/.test(error.code);
      const state=capacity?'waiting_for_capacity':funding?'waiting_for_funding':'recovery_needed';
      const code=capacity?'recovery_waiting_for_capacity':funding?'recovery_waiting_for_funding':'recovery_needed';
      await tx.query("UPDATE cloud_workspace_restore_incidents SET state=$2,reason=$3,next_attempt_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1",[job.id,state,error.code]);
      await tx.query("UPDATE cloud_workspaces SET last_error_code=$2,last_error_message=$3,version=version+1,updated_at=now() WHERE id=$1",[scope.workspace_id,code,
        capacity?'Recovery is waiting for capacity':funding?'Recovery is waiting for compute funding':'Recovery needs attention. The source is preserved.']);
    }
    return true;
  });
}

/** Funding/capacity refusals do not consume a second candidate. The normal
 * reconciler rechecks paid authority and the original finite allocation key. */
export async function deferCloudRecoveryResourceBlock(tx: Tx, input: {workspaceId:string;transitionId:string|null;intentId:string;code:string}): Promise<boolean> {
  if(!input.transitionId)return false;
  const funding=['compute_credit_exhausted','compute_allowance_pending','compute_allowance_unavailable','compute_allowance_exhausted','provider_budget_exhausted'].includes(input.code);
  const capacity=['provider_capacity_unavailable','provider_quota_exceeded','provider_vm_quota_exhausted','provider_vm_quota_unavailable','cloud_replacement_headroom_exceeded'].includes(input.code);
  if(!funding&&!capacity)return false;
  const deferred=await tx.query(`UPDATE cloud_workspace_restore_incidents SET state=$2,reason=$3,next_attempt_at=now()+interval '30 seconds',updated_at=now()
    WHERE transition_id=$1 AND state IN ('restoring','waiting_for_capacity','waiting_for_funding') AND deadline_at>now() RETURNING id`,
    [input.transitionId,funding?'waiting_for_funding':'waiting_for_capacity',input.code]);
  if(!deferred.rowCount)return false;
  await tx.query(`UPDATE cloud_workspace_lifecycle_intents SET state='observing',lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=now()+interval '30 seconds',
    error_code=$2,updated_at=now() WHERE id=$1`,[input.intentId,input.code]);
  await tx.query("UPDATE cloud_workspaces SET last_error_code=$2,version=version+1,updated_at=now() WHERE id=$1",[input.workspaceId,funding?'recovery_waiting_for_funding':'recovery_waiting_for_capacity']);
  return true;
}
