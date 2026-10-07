import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { RuntimeUpdateResult } from "./runtime-update-runner.js";
import { audit } from "../audit.js";
import { requireOrganizationCreationCapability, type StaffRole } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { CloudActiveRuntimeSchema, CloudAgentRuntimeSchema, type CloudActiveRuntime } from "./runtime-contract.js";
import type { CloudRuntimeQualificationMode } from "./runtime-config.js";
import { copyGenerationPins, loadGenerationSource } from "./generation-pins.js";
import { lockCloudWorkspaceGenerationTransition } from "./generation-transitions.js";
import { readCloudRuntimeResumeProofEpoch } from "./runtime-transition.js";
import { readCloudWorkspaceCredentialKinds, selectCloudWorkspaceRuntimeUpgrade } from "./runtime-upgrade-availability.js";
import { cloudRuntimePinValues, loadPinnedCloudRuntime } from "./runtime-selection.js";
import { verifyRuntimeTransferReport } from "./runtime-transfer-proof.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";
import { CloudResidentWitnessSchema, CloudRuntimeHandoffRequestSchema, CloudRuntimeHandoffReceiptSchema,
  detachedResident, sameHandoff, sameResidentHost, type CloudResidentWitness, type CloudRuntimeHandoffRequest,
  type CloudRuntimeHandoffReceipt } from "./runtime-handoff-contract.js";
import { cloneDatabaseCloudWorkspaceSettingsForRollback, persistCloudWorkspaceSetupSecrets,
  persistDatabaseCloudWorkspaceSettings } from "./settings.js";

export type CloudRuntimeTransition = {
  transitionId: string; sourceGeneration: number; candidateGeneration: number; phase: string;
  executionMode: "replace_allocation" | "retain_allocation";
};

export type CloudRuntimeTransitionClaim = {
  workspaceId: string; organizationId: string; transitionId: string;
  workerId: string; workerFence: string; executionFence: string;
};
export type CloudRuntimeActivationPolicy = {
  id: string;
  /** Called under the common lifecycle lock after core authority checks.
   * Trusted policy code owns workload/presence/safe-point evidence. */
  authorize(tx: Tx, transition: CloudRuntimeTransitionClaim): Promise<boolean>;
};
export type CloudRuntimeTransferEnrollment = {
  id: string; engineInstanceId: string; generation: number; executionFence: number;
  token: string; bridgeToken: string; readinessProbeToken: string; expiresAt: Date;
  resident?: { hostId: string; fence: number };
};

type ResidentConsumption = { handoff: CloudRuntimeHandoffRequest; receipt: CloudRuntimeHandoffReceipt;
  resident: CloudResidentWitness };
type HandoffRow = { phase: "consumption_authorized" | "consumed" | "source_retired" | "uncertain" | "cancelled";
  request: CloudRuntimeHandoffRequest; source_resident: CloudResidentWitness;
  consumed_resident: CloudResidentWitness | null; deadline_at: Date };

type TransitionRow = {
  transition_id: string; workspace_id: string; org_id: string;
  source_generation: number; candidate_generation: number; source_engine_instance_id: string;
  provider_resource_id: string; mode: "bootstrap" | "engine"; phase: string;
  execution_fence: string; source_active: CloudActiveRuntime; stage_live: boolean;
  controller_active: CloudActiveRuntime | null; enrollment_sequence: number;
  activation_deadline_at: Date | null; rollback_deadline_at: Date | null;
};

const hash = (value: string) => createHash("sha256").update(value).digest();
const capability = (prefix: string) => prefix+randomBytes(32).toString("base64url");
const same = (left: CloudActiveRuntime,right: CloudActiveRuntime) =>
  Object.keys(left).every(key=>left[key as keyof CloudActiveRuntime]===right[key as keyof CloudActiveRuntime]);

const scopeColumns = `runtime.*,transition.source_generation,transition.candidate_generation,
  runtime.stage_deadline_at>clock_timestamp() AS stage_live`;

export class DatabaseCloudRuntimeTransitionService {
  constructor(readonly options: {
    pool: pg.Pool; qualificationMode: CloudRuntimeQualificationMode; workosEnabled: boolean;
    secretEncryptionKeys?: Readonly<Record<number, string>>;
    currentSecretEncryptionKeyVersion?: number | null;
    heartbeatEndpoint?: string;
  }) {}

  async enroll(claim: CloudRuntimeTransitionClaim, proof: {
    active: CloudActiveRuntime; controller: CloudActiveRuntime; report: Record<string, unknown>; rollback: boolean;
    resident?: CloudResidentWitness;
  }): Promise<CloudRuntimeTransferEnrollment | null> {
    const active = CloudActiveRuntimeSchema.safeParse(proof.active), controller = CloudActiveRuntimeSchema.safeParse(proof.controller);
    if (!active.success || !controller.success) return null;
    return withSystemTx(this.options.pool,async tx => {
      const row = await this.locked(tx,claim);
      if (!row || row.phase!==(proof.rollback?'rolling_back':'activated') || row.enrollment_sequence>=8 ||
        active.data.bootId!==row.source_active.bootId || active.data.baseCompatibilityId!==row.source_active.baseCompatibilityId ||
        active.data.supervisorSessionId===row.source_active.supervisorSessionId ||
        (row.mode==='bootstrap' ? !same(active.data,controller.data) : !row.controller_active || !same(row.controller_active,controller.data))) return null;
      const journal = await this.handoff(tx, claim.transitionId);
      const resident = CloudResidentWitnessSchema.safeParse(proof.resident);
      if (journal ? journal.phase !== "source_retired" || !resident.success || !journal.consumed_resident ||
        !sameResidentHost(journal.consumed_resident, resident.data) || resident.data.engineId !== null ||
        resident.data.fence < journal.consumed_resident.fence || !Number.isSafeInteger(resident.data.fence + 1)
        : proof.resident !== undefined) return null;
      if (journal && resident.success) {
        // A rollback must prove the target's resident attachment was detached.
        // A failed pre-start target may still have the original detached fence.
        const previous = (await tx.query<{ resident_witness: CloudResidentWitness | null; consumed_at: Date | null }>(`SELECT resident_witness,consumed_at
          FROM cloud_workspace_runtime_enrollments WHERE transition_id=$1 ORDER BY sequence DESC LIMIT 1`, [claim.transitionId])).rows[0];
        const expected = previous?.resident_witness ?? journal.consumed_resident!;
        const fences = previous ? previous.consumed_at ? [expected.fence + 2] : [expected.fence, expected.fence + 2] : [expected.fence];
        if (!sameResidentHost(expected, resident.data) || !fences.includes(resident.data.fence)) return null;
      }
      const generation = proof.rollback ? row.source_generation : row.candidate_generation;
      const saved = await loadGenerationSource(tx,{...claim,generation});
      if (!saved.runtime || active.data.runtimeId!==saved.runtime.runtimeId || active.data.manifestSha256!==saved.runtime.manifestSha256 ||
        (proof.rollback && active.data.installerReceiptSha256!==row.source_active.installerReceiptSha256) ||
        !await loadPinnedCloudRuntime(tx,saved.runtime,this.options.qualificationMode,await readCloudWorkspaceCredentialKinds(tx,claim))) return null;
      const reportDigest = verifyRuntimeTransferReport(proof.report,active.data,saved.profile);
      if (!reportDigest || !await this.qualified(tx,claim.transitionId,proof.rollback) || (await tx.query(`SELECT 1 FROM cloud_workspace_engine_instances WHERE workspace_id=$1
        AND runtime_supervisor_session_id=$2`, [claim.workspaceId,active.data.supervisorSessionId])).rowCount) return null;
      const authority = (await tx.query<{ owner_user_id: string; expires_at: Date }>(`SELECT workspace.owner_user_id,
        least(CASE WHEN $4 THEN runtime.rollback_deadline_at ELSE runtime.activation_deadline_at END,
          clock_timestamp()+interval '120 seconds') AS expires_at
        FROM cloud_workspaces workspace JOIN cloud_workspace_runtime_transitions runtime ON runtime.workspace_id=workspace.id
        WHERE runtime.transition_id=$1 AND workspace.id=$2 AND workspace.org_id=$3
          AND workspace.desired_state='running' AND workspace.deleted_at IS NULL
          AND CASE WHEN $4 THEN runtime.rollback_deadline_at ELSE runtime.activation_deadline_at END>clock_timestamp()+interval '5 seconds'
          AND cloud_workspace_runtime_authority_live(workspace.id,workspace.current_generation,workspace.owner_user_id,$5)`,
      [claim.transitionId,claim.workspaceId,claim.organizationId,proof.rollback,this.options.workosEnabled])).rows[0];
      if (!authority) return null;
      const id=randomUUID(),engineInstanceId=randomUUID(),sequence=row.enrollment_sequence+1;
      const token=capability("zws_"),bridgeToken=capability("zwb_"),readinessProbeToken=capability("zwr_");
      await tx.query(`UPDATE cloud_workspace_runtime_transitions SET phase=$2,enrollment_sequence=$3,
        updated_at=clock_timestamp() WHERE transition_id=$1`, [claim.transitionId,proof.rollback?'rollback_enrolling':'enrolling',sequence]);
      await tx.query(`INSERT INTO cloud_workspace_runtime_enrollments(id,transition_id,workspace_id,org_id,generation,
        engine_instance_id,account_user_id,execution_fence,sequence,direction,token_hash,expires_at,active,controller_active,report_sha256,resident_witness)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16::jsonb)`,
      [id,claim.transitionId,claim.workspaceId,claim.organizationId,generation,engineInstanceId,authority.owner_user_id,
        claim.executionFence,sequence,proof.rollback?'rollback':'target',hash(token),authority.expires_at,JSON.stringify(active.data),
        JSON.stringify(controller.data),reportDigest,resident.success ? JSON.stringify(resident.data) : null]);
      await tx.query(`INSERT INTO cloud_workspace_engine_instances(id,workspace_id,generation,org_id,account_user_id,
        runtime_transition_enrollment_id,protocol_version,state,bridge_token_hash,
        runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version,
        runtime_installer_receipt_sha256,runtime_boot_id,runtime_supervisor_session_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,'starting',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [engineInstanceId,claim.workspaceId,generation,claim.organizationId,authority.owner_user_id,id,saved.runtime.engineProtocolVersion,
        hash(bridgeToken),...cloudRuntimePinValues(saved.runtime),active.data.installerReceiptSha256,active.data.bootId,active.data.supervisorSessionId]);
      return {id,engineInstanceId,generation,executionFence:sequence,token,bridgeToken,readinessProbeToken,expiresAt:authority.expires_at,
        ...(resident.success ? { resident: { hostId: resident.data.hostId, fence: resident.data.fence + 1 } } : {})};
    });
  }

  async register(input: {
    workspaceId: string; organizationId: string; generation: number; setupRunId: string; executionFence: number;
    engineInstanceId: string; token: string; protocolVersion: number; actorProtocolVersion?: number;
    agentRuntime?: unknown; agentCustomizationVersion?: number;
  }) {
    const identity = CloudAgentRuntimeSchema.safeParse(input.agentRuntime);
    const reject = () => new Error("Runtime transition registration rejected");
    if (!/^zws_[A-Za-z0-9_-]{43}$/.test(input.token) || !identity.success || identity.data.profile!=="zeros-cloud-worker-v4" ||
      input.protocolVersion!==CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION || input.actorProtocolVersion!==2 ||
      (input.agentCustomizationVersion!==undefined && input.agentCustomizationVersion!==3) || !this.options.heartbeatEndpoint) throw reject();
    return withSystemTx(this.options.pool,async tx => {
      await lockCloudWorkspaceGenerationTransition(tx,input);
      const enrollment = (await tx.query<{
        transition_id: string; active: CloudActiveRuntime; token_hash: Buffer; account_user_id: string; direction: string;
      }>(`SELECT enrollment.transition_id,enrollment.active,enrollment.token_hash,enrollment.account_user_id,enrollment.direction
        FROM cloud_workspace_runtime_enrollments enrollment
        JOIN cloud_workspace_runtime_transitions runtime ON runtime.transition_id=enrollment.transition_id
        JOIN cloud_workspace_generation_transitions transition ON transition.id=runtime.transition_id
        JOIN cloud_workspaces workspace ON workspace.id=enrollment.workspace_id AND workspace.org_id=enrollment.org_id
        WHERE enrollment.id=$1 AND enrollment.workspace_id=$2 AND enrollment.org_id=$3 AND enrollment.generation=$4
          AND enrollment.engine_instance_id=$5 AND enrollment.sequence=$6 AND enrollment.sequence=runtime.enrollment_sequence
          AND enrollment.execution_fence=runtime.execution_fence AND enrollment.consumed_at IS NULL AND enrollment.revoked_at IS NULL
          AND enrollment.expires_at>clock_timestamp() AND workspace.desired_state='running' AND workspace.deleted_at IS NULL
          AND transition.state IN ('setting_up','rolling_back') AND transition.execution_mode='retain_allocation'
          AND ((enrollment.direction='target' AND runtime.phase='enrolling' AND runtime.activation_deadline_at>clock_timestamp())
            OR (enrollment.direction='rollback' AND runtime.phase='rollback_enrolling' AND runtime.rollback_deadline_at>clock_timestamp()))
          AND cloud_workspace_runtime_authority_live(workspace.id,workspace.current_generation,enrollment.account_user_id,$7)
        FOR UPDATE OF enrollment,runtime,transition`,
      [input.setupRunId,input.workspaceId,input.organizationId,input.generation,input.engineInstanceId,input.executionFence,this.options.workosEnabled])).rows[0];
      if (!enrollment || !timingSafeEqual(enrollment.token_hash,hash(input.token))) throw reject();
      const witness=identity.data;
      if (witness.profile!=="zeros-cloud-worker-v4") throw reject();
      if (witness.runtimeId!==enrollment.active.runtimeId || witness.manifestSha256!==enrollment.active.manifestSha256 ||
        witness.baseCompatibilityId!==enrollment.active.baseCompatibilityId || witness.bootId!==enrollment.active.bootId ||
        witness.installerReceiptSha256!==enrollment.active.installerReceiptSha256 || witness.supervisorSessionId!==enrollment.active.supervisorSessionId) throw reject();
      if (!await this.qualified(tx,enrollment.transition_id,enrollment.direction==='rollback')) throw reject();
      await this.transfer(tx,{...input,transitionId:enrollment.transition_id});
      await tx.query(`UPDATE cloud_workspace_runtime_enrollments SET consumed_at=clock_timestamp() WHERE id=$1`,[input.setupRunId]);
      const heartbeatToken=capability("zwh_");
      const updated=(await tx.query<{lease_expires_at: Date}>(`UPDATE cloud_workspace_engine_instances SET state='ready',
        heartbeat_token_hash=$2,registered_at=clock_timestamp(),last_heartbeat_at=clock_timestamp(),
        lease_expires_at=clock_timestamp()+interval '90 seconds',actor_protocol_version=2,agent_customization_version=$3,
        updated_at=clock_timestamp() WHERE id=$1 AND state='starting' RETURNING lease_expires_at`,
      [input.engineInstanceId,hash(heartbeatToken),input.agentCustomizationVersion??null])).rows[0];
      if (!updated) throw reject();
      await tx.query(`UPDATE cloud_workspace_runtime_transitions SET phase=$2,updated_at=clock_timestamp() WHERE transition_id=$1`,
      [enrollment.transition_id,enrollment.direction==='rollback'?'rollback_checking':'checking']);
      await audit(tx,input.organizationId,null,"cloud_workspace.runtime_transfer_registered",{
        workspaceId:input.workspaceId,transitionId:enrollment.transition_id,generation:input.generation,engineInstanceId:input.engineInstanceId });
      return {version:1 as const,audience:"zeros-cloud-workspace-engine-registration-v1",engineInstanceId:input.engineInstanceId,
        durableRecordConnected:true as const,leaseExpiresAtMs:updated.lease_expires_at.getTime(),
        heartbeat:{endpoint:this.options.heartbeatEndpoint!,token:heartbeatToken,intervalMs:30_000}};
    });
  }

  private async qualified(tx: Tx, transitionId: string, rollback=false): Promise<boolean> {
    const row=(await tx.query<TransitionRow>(`SELECT ${scopeColumns} FROM cloud_workspace_runtime_transitions runtime
      JOIN cloud_workspace_generation_transitions transition ON transition.id=runtime.transition_id WHERE transition.id=$1`,[transitionId])).rows[0];
    if (!row) return false;
    const scope={workspaceId:row.workspace_id,organizationId:row.org_id};
    const source=await loadGenerationSource(tx,{...scope,generation:row.source_generation});
    const target=await loadGenerationSource(tx,{...scope,generation:row.candidate_generation});
    const kinds=await readCloudWorkspaceCredentialKinds(tx,scope);
    if (!source.runtime || !target.runtime ||
      !await loadPinnedCloudRuntime(tx,source.runtime,this.options.qualificationMode,kinds) ||
      (!rollback && !await loadPinnedCloudRuntime(tx,target.runtime,this.options.qualificationMode,kinds))) return false;
    const qualified = (await tx.query<{qualified:boolean}>(`SELECT cloud_runtime_transfer_qualified($1,$2,$3,$4,$5,$6) AS qualified`,
      [source.runtime.runtimeId,target.runtime.runtimeId,row.mode==='bootstrap'?target.runtime.runtimeId:row.controller_active?.runtimeId,
        source.runtime.baseCompatibilityId,row.mode,this.options.qualificationMode])).rows[0]?.qualified===true;
    if (!qualified) return false;
    const journal = await this.handoff(tx, transitionId);
    return !journal || journal.phase === "source_retired" && await this.residentQualified(tx, row, journal.source_resident);
  }

  private async transfer(tx: Tx,input: {workspaceId:string;organizationId:string;transitionId:string;generation:number;engineInstanceId:string}) {
    const owner=(await tx.query<{current_generation:number;provider_resource_id:string;revision:string}>(`SELECT owner.current_generation,
      owner.provider_resource_id,owner.revision FROM cloud_workspace_allocation_owners owner
      JOIN cloud_workspace_runtime_transitions runtime USING(workspace_id,org_id,provider_resource_id)
      JOIN cloud_workspaces workspace ON workspace.id=owner.workspace_id AND workspace.org_id=owner.org_id
      WHERE runtime.transition_id=$1 AND owner.workspace_id=$2 AND owner.org_id=$3
        AND workspace.current_generation=owner.current_generation FOR UPDATE OF owner`,
    [input.transitionId,input.workspaceId,input.organizationId])).rows[0];
    if (!owner) throw new Error("Runtime allocation transfer rejected");
    await tx.query(`SELECT id FROM managed_compute_allocation_leases WHERE workspace_id=$1 AND provider_resource_id=$2 FOR UPDATE`,
      [input.workspaceId,owner.provider_resource_id]);
    if ((await tx.query(`SELECT 1 FROM cloud_workspace_allocation_operations WHERE workspace_id=$1 AND provider_resource_id=$2 AND state<>'completed'
      UNION ALL SELECT 1 FROM managed_compute_allocation_leases WHERE workspace_id=$1 AND provider_resource_id=$2
        AND state<>'settled' AND (state<>'active' OR stop_intent_id IS NOT NULL OR lease_expires_at>clock_timestamp())`,
    [input.workspaceId,owner.provider_resource_id])).rowCount) throw new Error("Runtime allocation transfer blocked");
    if (owner.current_generation===input.generation) return;
    const binding=(await tx.query<{observed_state:string;observed_metadata:Record<string,unknown>;provider_target:string|null;last_observed_at:Date|null}>(`UPDATE cloud_workspace_provider_bindings
      SET provider_resource_id=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND provider_resource_id=$4
      RETURNING observed_state,observed_metadata,provider_target,last_observed_at`,[input.workspaceId,input.organizationId,owner.current_generation,owner.provider_resource_id])).rows[0];
    if (!binding || binding.observed_state!=='running') throw new Error("Runtime allocation transfer rejected");
    const target=await tx.query(`UPDATE cloud_workspace_provider_bindings SET provider_resource_id=$4,observed_state=$5,
      observed_metadata=$6::jsonb,provider_target=$7,last_observed_at=$8,updated_at=clock_timestamp() WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND provider_resource_id IS NULL`,
    [input.workspaceId,input.organizationId,input.generation,owner.provider_resource_id,binding.observed_state,JSON.stringify(binding.observed_metadata),binding.provider_target,binding.last_observed_at]);
    if (target.rowCount!==1) throw new Error("Runtime allocation transfer rejected");
    await tx.query(`UPDATE cloud_workspace_allocation_owners SET current_generation=$3,revision=revision+1,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND provider_resource_id=$2`,[input.workspaceId,owner.provider_resource_id,input.generation]);
    await tx.query(`INSERT INTO cloud_workspace_allocation_transfers(workspace_id,org_id,provider_resource_id,revision,transition_id,
      source_generation,target_generation,engine_instance_id) VALUES($1,$2,$3,$4::bigint+1,$5,$6,$7,$8)`,
    [input.workspaceId,input.organizationId,owner.provider_resource_id,owner.revision,input.transitionId,owner.current_generation,input.generation,input.engineInstanceId]);
    await tx.query(`UPDATE cloud_workspaces SET current_generation=$3,authority_epoch=authority_epoch+1,version=version+1,updated_at=clock_timestamp()
      WHERE id=$1 AND org_id=$2`,[input.workspaceId,input.organizationId,input.generation]);
  }

  /** Probe must use the pinned root controller channel, never engine HTTP input.
   * The fresh challenge makes a recovered worker prove this exact launch. */
  async verifyHealth(claim: CloudRuntimeTransitionClaim, probe: (challenge:string)=>Promise<{
    challenge:string;executionFence:string;active:CloudActiveRuntime;engineInstanceId:string;
    protocolVersion:number;health:"ready";durableRecordConnected:true;
    resident?: CloudResidentWitness;
  }>): Promise<boolean> {
    const challenge=capability("zuh_");
    const enrollmentId=await withSystemTx(this.options.pool,async tx=>{
      const row=await this.locked(tx,claim);
      if (!row || !['checking','rollback_checking'].includes(row.phase)) return null;
      const result=await tx.query<{id:string}>(`UPDATE cloud_workspace_runtime_enrollments enrollment
        SET health_challenge_sha256=$2,health_deadline_at=least(expires_at,clock_timestamp()+interval '30 seconds')
        WHERE transition_id=$1 AND sequence=$3 AND consumed_at IS NOT NULL AND revoked_at IS NULL
          AND expires_at>clock_timestamp() RETURNING id`,[claim.transitionId,hash(challenge),row.enrollment_sequence]);
      return result.rows[0]?.id??null;
    });
    if (!enrollmentId) return false;
    let observation: Awaited<ReturnType<typeof probe>>;
    try { observation=await probe(challenge); } catch { return false; }
    const observed=CloudActiveRuntimeSchema.safeParse(observation?.active);
    if (!observed.success || typeof observation.challenge!=="string" ||
      !timingSafeEqual(hash(observation.challenge),hash(challenge)) || observation.executionFence!==claim.executionFence ||
      observation.protocolVersion!==CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION || observation.health!=="ready" || observation.durableRecordConnected!==true) return false;
    return withSystemTx(this.options.pool,async tx=>{
      const row=await this.locked(tx,claim);
      if (!row || !['checking','rollback_checking'].includes(row.phase) || !await this.qualified(tx,claim.transitionId,row.phase==='rollback_checking')) return false;
      const enrollment=(await tx.query<{generation:number;active:CloudActiveRuntime;resident_witness:CloudResidentWitness|null}>(`SELECT enrollment.generation,enrollment.active,enrollment.resident_witness
        FROM cloud_workspace_runtime_enrollments enrollment JOIN cloud_workspace_engine_instances engine ON engine.id=enrollment.engine_instance_id
        JOIN cloud_workspaces workspace ON workspace.id=enrollment.workspace_id AND workspace.org_id=enrollment.org_id
        WHERE enrollment.id=$1 AND enrollment.sequence=$2 AND enrollment.engine_instance_id=$3
          AND enrollment.health_challenge_sha256=$4 AND enrollment.health_deadline_at>clock_timestamp()
          AND enrollment.revoked_at IS NULL AND enrollment.consumed_at IS NOT NULL
          AND workspace.current_generation=enrollment.generation AND workspace.desired_state='running' AND workspace.deleted_at IS NULL
          AND engine.state='ready' AND engine.lease_expires_at>clock_timestamp()
          AND cloud_workspace_runtime_authority_live(workspace.id,enrollment.generation,enrollment.account_user_id,$5)
          FOR UPDATE OF enrollment,engine`,[enrollmentId,row.enrollment_sequence,observation.engineInstanceId,hash(challenge),this.options.workosEnabled])).rows[0];
      if (!enrollment || !same(enrollment.active,observed.data)) return false;
      const resident = CloudResidentWitnessSchema.safeParse(observation.resident);
      if (enrollment.resident_witness ? !resident.success || !sameResidentHost(enrollment.resident_witness, resident.data) ||
        resident.data.fence !== enrollment.resident_witness.fence + 1 || resident.data.engineId !== observation.engineInstanceId ||
        resident.data.generation !== enrollment.generation : observation.resident !== undefined) return false;
      await tx.query(`INSERT INTO cloud_workspace_runtime_attestations(enrollment_id,engine_instance_id,health_challenge_sha256,engine_health,durable_record_connected)
        VALUES($1,$2,$3,'ready',true)`,[enrollmentId,observation.engineInstanceId,hash(challenge)]);
      await tx.query(`UPDATE cloud_workspace_runtime_enrollments SET health_challenge_sha256=NULL,health_deadline_at=NULL WHERE id=$1`,[enrollmentId]);
      return true;
    });
  }

  /** Only an authenticated final controller journal receipt publishes ordinary
   * admissions. A health reply alone can still be lost before VM commit. */
  async finish(claim:CloudRuntimeTransitionClaim,result:RuntimeUpdateResult):Promise<boolean> {
    const active=CloudActiveRuntimeSchema.safeParse(result.active);
    if (!active.success || result.schema!=="zeros.runtime-update/v1" || result.operation!=="activate" ||
      result.transitionId!==claim.transitionId || result.fence!==claim.executionFence || result.scope.workspaceId!==claim.workspaceId ||
      result.scope.organizationId!==claim.organizationId || !['healthy','rolled_back'].includes(result.outcome)) return false;
    return withSystemTx(this.options.pool,async tx=>{
      const row=await this.locked(tx,claim),rollback=result.outcome==='rolled_back';
      if (!row || row.phase!==(rollback?'rollback_checking':'checking') || result.scope.sourceGeneration!==row.source_generation ||
        result.scope.candidateGeneration!==row.candidate_generation || result.scope.sourceEngineInstanceId!==row.source_engine_instance_id ||
        !await this.qualified(tx,claim.transitionId,row.phase==='rollback_checking')) return false;
      const enrollment=(await tx.query<{generation:number;active:CloudActiveRuntime;engine_instance_id:string}>(`SELECT enrollment.generation,
        enrollment.active,enrollment.engine_instance_id FROM cloud_workspace_runtime_enrollments enrollment
        JOIN cloud_workspace_runtime_attestations proof ON proof.enrollment_id=enrollment.id AND proof.engine_instance_id=enrollment.engine_instance_id
        JOIN cloud_workspace_engine_instances engine ON engine.id=enrollment.engine_instance_id
        JOIN cloud_workspaces workspace ON workspace.id=enrollment.workspace_id AND workspace.org_id=enrollment.org_id
        WHERE enrollment.transition_id=$1 AND enrollment.sequence=$2 AND enrollment.revoked_at IS NULL
          AND proof.attested_at>clock_timestamp()-interval '30 seconds' AND enrollment.expires_at>clock_timestamp()
          AND workspace.current_generation=enrollment.generation AND workspace.desired_state='running' AND workspace.deleted_at IS NULL
          AND engine.state='ready' AND engine.lease_expires_at>clock_timestamp()
          AND cloud_workspace_runtime_authority_live(workspace.id,enrollment.generation,enrollment.account_user_id,$3)
        ORDER BY proof.attested_at DESC LIMIT 1`,[claim.transitionId,row.enrollment_sequence,this.options.workosEnabled])).rows[0];
      if (!enrollment || !same(enrollment.active,active.data)) return false;
      await tx.query(`UPDATE cloud_workspace_runtime_transitions SET phase=$2,completed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE transition_id=$1`,[claim.transitionId,rollback?'rolled_back':'healthy']);
      await tx.query(`UPDATE cloud_workspace_generation_transitions SET state=$2,completed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1`,[claim.transitionId,rollback?'rolled_back':'succeeded']);
      await tx.query(`UPDATE cloud_workspaces SET status='ready',version=version+1,updated_at=clock_timestamp(),
        last_error_code=NULL,last_error_message=NULL WHERE id=$1 AND org_id=$2`,[claim.workspaceId,claim.organizationId]);
      await audit(tx,claim.organizationId,null,"cloud_workspace.runtime_transfer_verified",{workspaceId:claim.workspaceId,
        transitionId:claim.transitionId,generation:enrollment.generation,engineInstanceId:enrollment.engine_instance_id,rollback});
      return true;
    });
  }

  async beginRollback(claim:CloudRuntimeTransitionClaim):Promise<boolean> {
    return withSystemTx(this.options.pool,async tx=>{
      const row=await this.locked(tx,claim);
      if (!row || !['activated','enrolling','checking'].includes(row.phase)) return false;
      await this.rollback(tx,claim);
      return true;
    });
  }
  private async rollback(tx:Tx,claim:CloudRuntimeTransitionClaim) {
    await retireCloudWorkspaceRuntimeAccess(tx,{...claim,reason:"generation_candidate_rejected"});
    await tx.query(`UPDATE cloud_workspace_runtime_enrollments SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE transition_id=$1`,[claim.transitionId]);
    await tx.query(`UPDATE cloud_workspace_runtime_transitions SET phase='rolling_back',rollback_deadline_at=clock_timestamp()+interval '240 seconds',
      updated_at=clock_timestamp() WHERE transition_id=$1`,[claim.transitionId]);
    await tx.query(`UPDATE cloud_workspace_generation_transitions SET state='rolling_back',updated_at=clock_timestamp() WHERE id=$1`,[claim.transitionId]);
    await tx.query(`UPDATE cloud_workspaces SET status='setting_up',authority_epoch=authority_epoch+1,version=version+1,updated_at=clock_timestamp()
      WHERE id=$1 AND org_id=$2`,[claim.workspaceId,claim.organizationId]);
  }

  /** Durable deadline reconciliation does not infer disk state. A new worker
   * keeps the execution fence and obtains fresh controller/health evidence. */
  async reconcile(claim:CloudRuntimeTransitionClaim):Promise<"stage"|"activate"|"inspect"|"rollback"|"cancelled"|"recovery_required"|null> {
    return withSystemTx(this.options.pool,async tx=>{
      const row=await this.locked(tx,claim);
      if (!row) return null;
      const now=(await tx.query<{now:Date}>("SELECT clock_timestamp() AS now")).rows[0]!.now;
      const journal = await this.handoff(tx, claim.transitionId);
      if (journal && journal.phase !== "source_retired") {
        if (journal.phase !== "uncertain" && journal.deadline_at > now) {
          if (journal.phase === "consumed") {
            await this.retireSource(tx, claim, row.source_generation);
            await tx.query(`UPDATE cloud_workspace_runtime_handoffs SET phase='source_retired',source_retired_at=clock_timestamp()
              WHERE transition_id=$1`, [claim.transitionId]);
          }
          return "inspect";
        }
        // Consumption may have happened. Never cancel staging or resurrect a
        // writer on the strength of an expired claim or a missing reply.
        await retireCloudWorkspaceRuntimeAccess(tx, { ...claim, reason: "generation_candidate_rejected" });
        await tx.query("UPDATE cloud_workspace_runtime_handoffs SET phase='uncertain' WHERE transition_id=$1", [claim.transitionId]);
        await tx.query("UPDATE cloud_workspace_runtime_transitions SET phase='recovery_required',updated_at=clock_timestamp() WHERE transition_id=$1", [claim.transitionId]);
        await tx.query(`UPDATE cloud_workspaces SET status='failed',authority_epoch=authority_epoch+1,version=version+1,updated_at=clock_timestamp(),
          last_error_code='recovery_needed',last_error_message='Runtime handoff recovery needs verification. The allocation is preserved.'
          WHERE id=$1 AND org_id=$2`, [claim.workspaceId, claim.organizationId]);
        return "recovery_required";
      }
      if (['offered','staged'].includes(row.phase)) {
        if (row.stage_live) return row.phase==='offered'?'stage':'activate';
        await tx.query(`UPDATE cloud_workspace_runtime_transitions SET phase='cancelled',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE transition_id=$1`,[claim.transitionId]);
        await tx.query(`UPDATE cloud_workspace_generation_transitions SET state='cancelled',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[claim.transitionId]);
        return 'cancelled';
      }
      if (['activated','enrolling','checking'].includes(row.phase) && row.activation_deadline_at && row.activation_deadline_at<=now) {
        await this.rollback(tx,claim);
        return 'rollback';
      }
      if (['rolling_back','rollback_enrolling','rollback_checking'].includes(row.phase) && row.rollback_deadline_at && row.rollback_deadline_at<=now) {
        await retireCloudWorkspaceRuntimeAccess(tx,{...claim,reason:"generation_candidate_rejected"});
        await tx.query(`UPDATE cloud_workspace_runtime_enrollments SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE transition_id=$1`,[claim.transitionId]);
        await tx.query(`UPDATE cloud_workspace_runtime_transitions SET phase='recovery_required',updated_at=clock_timestamp() WHERE transition_id=$1`,[claim.transitionId]);
        await tx.query(`UPDATE cloud_workspaces SET status='failed',authority_epoch=authority_epoch+1,version=version+1,updated_at=clock_timestamp(),
          last_error_code='recovery_needed',last_error_message='Runtime update recovery needs verification. The allocation is preserved.'
          WHERE id=$1 AND org_id=$2`,[claim.workspaceId,claim.organizationId]);
        return 'recovery_required';
      }
      return row.phase==='recovery_required'?'recovery_required':row.phase==='rolling_back'?'rollback':'inspect';
    });
  }

  async claim(scope: { workspaceId: string; organizationId: string; transitionId: string }, workerId: string): Promise<CloudRuntimeTransitionClaim | null> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(workerId)) return null;
    return withSystemTx(this.options.pool,async tx => {
      await lockCloudWorkspaceGenerationTransition(tx,scope);
      const row = (await tx.query<{ worker_fence: string; execution_fence: string }>(`UPDATE cloud_workspace_runtime_transitions
        SET worker_id=$4,worker_fence=gen_random_uuid(),worker_expires_at=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp()
        WHERE transition_id=$1 AND workspace_id=$2 AND org_id=$3 AND phase NOT IN ('healthy','rolled_back','cancelled')
          AND (worker_id IS NULL OR worker_expires_at<=clock_timestamp()) RETURNING worker_fence,execution_fence`,
      [scope.transitionId,scope.workspaceId,scope.organizationId,workerId])).rows[0];
      return row ? { ...scope,workerId,workerFence:row.worker_fence,executionFence:row.execution_fence } : null;
    });
  }

  async renew(claim:CloudRuntimeTransitionClaim):Promise<boolean> {
    return withSystemTx(this.options.pool,async tx=>{
      if (!await this.locked(tx,claim)) return false;
      const result=await tx.query(`UPDATE cloud_workspace_runtime_transitions SET worker_expires_at=clock_timestamp()+interval '90 seconds'
        WHERE transition_id=$1 AND phase<>'recovery_required' AND greatest(stage_deadline_at,activation_deadline_at,rollback_deadline_at)>clock_timestamp()`,[claim.transitionId]);
      return result.rowCount===1;
    });
  }

  /** Relinquish a live worker lease, preserving the durable execution fence
   * and phase. A subsequent claim gets a new worker fence immediately. */
  async release(claim:CloudRuntimeTransitionClaim):Promise<boolean> {
    return withSystemTx(this.options.pool,async tx=>{
      if (!await this.locked(tx,claim)) return false;
      const released=await tx.query(`UPDATE cloud_workspace_runtime_transitions
        SET worker_id=NULL,worker_fence=NULL,worker_expires_at=NULL,updated_at=clock_timestamp()
        WHERE transition_id=$1 AND worker_expires_at>clock_timestamp()`,[claim.transitionId]);
      return released.rowCount===1;
    });
  }

  /** Cancel only an unswitched offer. Preserve the cancelling fence as an
   * idempotency receipt; cancelled rows cannot be claimed again. This never
   * retires source authority or issues provider lifecycle operations. */
  async cancelStaging(claim:CloudRuntimeTransitionClaim):Promise<boolean> {
    return withSystemTx(this.options.pool,async tx=>{
      await lockCloudWorkspaceGenerationTransition(tx,claim);
      const row=(await tx.query<{phase:string;activated_at:Date|null;state:string}>(`SELECT runtime.phase,runtime.activated_at,transition.state
        FROM cloud_workspace_runtime_transitions runtime
        JOIN cloud_workspace_generation_transitions transition ON transition.id=runtime.transition_id
        WHERE runtime.transition_id=$1 AND runtime.workspace_id=$2 AND runtime.org_id=$3
          AND runtime.worker_id=$4 AND runtime.worker_fence=$5 AND runtime.execution_fence=$6
          AND transition.execution_mode='retain_allocation'
        FOR UPDATE OF runtime,transition`,
      [claim.transitionId,claim.workspaceId,claim.organizationId,claim.workerId,claim.workerFence,claim.executionFence])).rows[0];
      if (!row || row.activated_at!==null) return false;
      if (await this.handoff(tx, claim.transitionId)) return false;
      if (row.phase==='cancelled' && row.state==='cancelled') return true;
      if (!['offered','staged'].includes(row.phase) || row.state!=='draining') return false;
      const cancelled=await tx.query(`UPDATE cloud_workspace_runtime_transitions
        SET phase='cancelled',completed_at=clock_timestamp(),worker_expires_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE transition_id=$1 AND worker_expires_at>clock_timestamp()`,[claim.transitionId]);
      if (cancelled.rowCount!==1) return false;
      await tx.query(`UPDATE cloud_workspace_generation_transitions SET state='cancelled',completed_at=clock_timestamp(),
        updated_at=clock_timestamp() WHERE id=$1`,[claim.transitionId]);
      return true;
    });
  }

  private async locked(tx: Tx, claim: CloudRuntimeTransitionClaim): Promise<TransitionRow | null> {
    await lockCloudWorkspaceGenerationTransition(tx,claim);
    return (await tx.query<TransitionRow>(`SELECT ${scopeColumns} FROM cloud_workspace_runtime_transitions runtime
      JOIN cloud_workspace_generation_transitions transition ON transition.id=runtime.transition_id
      WHERE runtime.transition_id=$1 AND runtime.workspace_id=$2 AND runtime.org_id=$3
        AND runtime.worker_id=$4 AND runtime.worker_fence=$5 AND runtime.execution_fence=$6
        AND runtime.worker_expires_at>clock_timestamp() AND transition.execution_mode='retain_allocation'
        AND transition.state IN ('draining','provisioning','setting_up','rolling_back')
      FOR UPDATE OF runtime,transition`,
    [claim.transitionId,claim.workspaceId,claim.organizationId,claim.workerId,claim.workerFence,claim.executionFence])).rows[0] ?? null;
  }

  /** Called only after the pinned installer conversation returned staged.
   * This receipt does not replace fresh attestation at enrollment. */
  async staged(claim: CloudRuntimeTransitionClaim): Promise<boolean> {
    return withSystemTx(this.options.pool,async tx => {
      const row = await this.locked(tx,claim);
      if (!row || !row.stage_live || !['offered','staged'].includes(row.phase) || await this.handoff(tx, claim.transitionId)) return false;
      await tx.query("UPDATE cloud_workspace_runtime_transitions SET phase='staged',updated_at=clock_timestamp() WHERE transition_id=$1", [row.transition_id]);
      return true;
    });
  }

  async activate(claim: CloudRuntimeTransitionClaim, input: {
    controller: CloudActiveRuntime | null; policy: CloudRuntimeActivationPolicy;
  }): Promise<boolean> {
    return this.authorizeActivation(claim, input);
  }

  /** A root receipt is consumed while source server authority is still live.
   * This commit is a durable intent, not permission to enroll the target. */
  async authorizeResidentConsumption(claim: CloudRuntimeTransitionClaim, input: {
    controller: CloudActiveRuntime; policy: CloudRuntimeActivationPolicy;
    handoff: CloudRuntimeHandoffRequest; receipt: CloudRuntimeHandoffReceipt; resident: CloudResidentWitness;
  }): Promise<boolean> {
    const handoff = CloudRuntimeHandoffRequestSchema.safeParse(input.handoff);
    const receipt = CloudRuntimeHandoffReceiptSchema.safeParse(input.receipt);
    const resident = CloudResidentWitnessSchema.safeParse(input.resident);
    if (!handoff.success || !receipt.success || !resident.success || !sameHandoff(handoff.data, receipt.data)) return false;
    return this.authorizeActivation(claim, input, { handoff: handoff.data, receipt: receipt.data, resident: resident.data });
  }

  private async handoff(tx: Tx, transitionId: string): Promise<HandoffRow | null> {
    return (await tx.query<HandoffRow>("SELECT * FROM cloud_workspace_runtime_handoffs WHERE transition_id=$1 FOR UPDATE", [transitionId])).rows[0] ?? null;
  }

  /** This API accepts only the exact detached witness returned by root's
   * resident-aware prepare. Never call it using engine HTTP or client input. */
  async recordResidentConsumption(claim: CloudRuntimeTransitionClaim, input: {
    handoff: CloudRuntimeHandoffRequest; resident: CloudResidentWitness;
  }): Promise<boolean> {
    const request = CloudRuntimeHandoffRequestSchema.safeParse(input.handoff), resident = CloudResidentWitnessSchema.safeParse(input.resident);
    if (!request.success || !resident.success) return false;
    return withSystemTx(this.options.pool, async tx => {
      const row = await this.locked(tx, claim), journal = row && await this.handoff(tx, claim.transitionId);
      if (!row || !journal || ["uncertain", "cancelled"].includes(journal.phase) || !sameHandoff(journal.request, request.data) ||
        !detachedResident(journal.source_resident, resident.data)) return false;
      if (journal.phase !== "consumption_authorized") return true;
      if (!(await tx.query("SELECT 1 WHERE $1::timestamptz>clock_timestamp()", [journal.deadline_at])).rowCount) return false;
      await tx.query(`UPDATE cloud_workspace_runtime_handoffs SET phase='consumed',consumed_at=clock_timestamp(),
        consumed_resident=$2::jsonb WHERE transition_id=$1`, [claim.transitionId, JSON.stringify(resident.data)]);
      return true;
    });
  }

  /** Root must have received an accepted cancel from the same live source
   * writer and re-read its still-attached resident witness. Timeouts and a
   * generic rejected prepare response are never cancellation evidence. */
  async cancelResidentConsumption(claim: CloudRuntimeTransitionClaim, input: {
    handoff: CloudRuntimeHandoffRequest; resident: CloudResidentWitness;
  }): Promise<boolean> {
    const request = CloudRuntimeHandoffRequestSchema.safeParse(input.handoff), resident = CloudResidentWitnessSchema.safeParse(input.resident);
    if (!request.success || !resident.success) return false;
    return withSystemTx(this.options.pool, async tx => {
      const row = await this.locked(tx, claim), journal = row && await this.handoff(tx, claim.transitionId);
      if (!row || !journal || journal.phase !== "consumption_authorized" || row.phase !== "staged" ||
        !sameHandoff(journal.request, request.data) || !sameResidentHost(journal.source_resident, resident.data) ||
        resident.data.fence !== journal.source_resident.fence || resident.data.engineId !== row.source_engine_instance_id ||
        resident.data.generation !== row.source_generation) return false;
      const live = await tx.query(`SELECT 1 FROM cloud_workspaces workspace
        JOIN cloud_workspace_engine_instances engine ON engine.id=$4 AND engine.workspace_id=workspace.id AND engine.org_id=workspace.org_id
        WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.current_generation=$3 AND engine.generation=$3
          AND workspace.desired_state='running' AND workspace.deleted_at IS NULL AND workspace.status IN ('ready','busy')
          AND engine.state='ready' AND engine.lease_expires_at>clock_timestamp() AND $5::timestamptz>clock_timestamp()
          AND cloud_workspace_runtime_authority_live(workspace.id,$3,workspace.owner_user_id,$6)`,
      [claim.workspaceId,claim.organizationId,row.source_generation,row.source_engine_instance_id,journal.deadline_at,this.options.workosEnabled]);
      if (!live.rowCount) return false;
      await tx.query("UPDATE cloud_workspace_runtime_handoffs SET phase='cancelled',cancelled_at=clock_timestamp() WHERE transition_id=$1", [claim.transitionId]);
      await tx.query("UPDATE cloud_workspace_runtime_transitions SET phase='cancelled',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE transition_id=$1", [claim.transitionId]);
      await tx.query("UPDATE cloud_workspace_generation_transitions SET state='cancelled',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [claim.transitionId]);
      return true;
    });
  }

  /** Separate commit after confirmed consumption. A crash between commits is
   * inspectable; neither worker expiry nor a lost reply can cancel the offer. */
  async retireResidentSource(claim: CloudRuntimeTransitionClaim): Promise<boolean> {
    return withSystemTx(this.options.pool, async tx => {
      const row = await this.locked(tx, claim), journal = row && await this.handoff(tx, claim.transitionId);
      if (!row || !journal) return false;
      if (journal.phase === "source_retired") return true;
      if (row.phase !== "staged" || journal.phase !== "consumed") return false;
      if (!(await tx.query("SELECT 1 WHERE $1::timestamptz>clock_timestamp()", [journal.deadline_at])).rowCount) return false;
      await this.retireSource(tx, claim, row.source_generation);
      await tx.query(`UPDATE cloud_workspace_runtime_handoffs SET phase='source_retired',source_retired_at=clock_timestamp()
        WHERE transition_id=$1`, [claim.transitionId]);
      return true;
    });
  }

  private async retireSource(tx: Tx, claim: CloudRuntimeTransitionClaim, generation: number) {
    await retireCloudWorkspaceRuntimeAccess(tx, { ...claim, generation, reason: "generation_replacement_requested" });
    await tx.query(`UPDATE cloud_workspaces SET status='setting_up',authority_epoch=authority_epoch+1,
      version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND org_id=$2`, [claim.workspaceId, claim.organizationId]);
    await tx.query(`UPDATE cloud_workspace_runtime_transitions SET phase='activated',activated_at=clock_timestamp(),
      activation_deadline_at=clock_timestamp()+interval '240 seconds',updated_at=clock_timestamp() WHERE transition_id=$1`, [claim.transitionId]);
    await tx.query("UPDATE cloud_workspace_generation_transitions SET state='setting_up',updated_at=clock_timestamp() WHERE id=$1", [claim.transitionId]);
  }

  private async residentQualified(tx: Tx, row: TransitionRow, resident: CloudResidentWitness): Promise<boolean> {
    const source = await loadGenerationSource(tx, { workspaceId: row.workspace_id, organizationId: row.org_id, generation: row.source_generation });
    const target = await loadGenerationSource(tx, { workspaceId: row.workspace_id, organizationId: row.org_id, generation: row.candidate_generation });
    if (!source.runtime || !target.runtime || !row.controller_active) return false;
    // The resident protocol is independent of the replaceable engine protocol.
    // An older host is allowed only by this exact, revocable qualification; do
    // not infer compatibility from a newly qualified engine or a version range.
    return !!(await tx.query(`SELECT 1 FROM cloud_runtime_resident_transfer_qualifications qualification
      JOIN cloud_runtime_bundles bundle ON bundle.runtime_id=qualification.resident_runtime_id
      WHERE qualification.source_runtime_id=$1 AND qualification.target_runtime_id=$2 AND qualification.controller_runtime_id=$3
        AND qualification.base_compatibility_id=$4 AND qualification.mode='engine' AND qualification.resident_runtime_id=$5
        AND qualification.protocol=$6 AND qualification.enabled AND qualification.revoked_at IS NULL
        AND (qualification.qualification_mode='full' OR qualification.qualification_mode=$7)
        AND bundle.manifest_sha256=$8 AND bundle.revoked_at IS NULL FOR SHARE OF qualification,bundle`,
    [source.runtime.runtimeId, target.runtime.runtimeId, row.controller_active.runtimeId, source.runtime.baseCompatibilityId,
      resident.runtimeId, resident.protocol, this.options.qualificationMode, resident.manifestSha256])).rowCount;
  }

  private async authorizeActivation(claim: CloudRuntimeTransitionClaim, input: {
    controller: CloudActiveRuntime | null; policy: CloudRuntimeActivationPolicy;
  }, resident?: ResidentConsumption): Promise<boolean> {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.policy.id)) return false;
    return withSystemTx(this.options.pool,async tx => {
      const row = await this.locked(tx,claim);
      if (!row || row.phase!=='staged' || !row.stage_live || await this.handoff(tx, claim.transitionId)) return false;
      const sourceScope = { ...claim,generation:row.source_generation };
      const source = await loadGenerationSource(tx,sourceScope);
      const target = await loadGenerationSource(tx,{ ...claim,generation:row.candidate_generation });
      const kinds = await readCloudWorkspaceCredentialKinds(tx,claim);
      if (!source.runtime || !target.runtime ||
        !await loadPinnedCloudRuntime(tx,source.runtime,this.options.qualificationMode,kinds) ||
        !await loadPinnedCloudRuntime(tx,target.runtime,this.options.qualificationMode,kinds)) return false;
      const controller = row.mode==='bootstrap' ? null : CloudActiveRuntimeSchema.safeParse(input.controller);
      if (row.mode==='bootstrap' ? input.controller!==null : !controller?.success ||
        controller.data.baseCompatibilityId!==row.source_active.baseCompatibilityId || controller.data.bootId!==row.source_active.bootId) return false;
      const controllerId = row.mode==='bootstrap' ? target.runtime.runtimeId : input.controller!.runtimeId;
      const qualified = await tx.query<{ qualified: boolean }>(`SELECT cloud_runtime_transfer_qualified($1,$2,$3,$4,$5,$6) AS qualified`,
      [source.runtime.runtimeId,target.runtime.runtimeId,controllerId,source.runtime.baseCompatibilityId,row.mode,this.options.qualificationMode]);
      if (!qualified.rows[0]?.qualified) return false;
      if (resident) {
        const { handoff, resident: witness } = resident;
        const now = (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.getTime();
        if (row.mode !== "engine" || handoff.workspaceId !== claim.workspaceId || handoff.organizationId !== claim.organizationId ||
          handoff.generation !== row.source_generation || handoff.engineInstanceId !== row.source_engine_instance_id ||
          handoff.hostId !== witness.hostId || handoff.fence !== witness.fence || handoff.expiresAtMs <= now || handoff.expiresAtMs > now + 900_000 ||
          witness.engineId !== handoff.engineInstanceId || witness.generation !== handoff.generation ||
          witness.workspaceId !== claim.workspaceId || witness.organizationId !== claim.organizationId || witness.bootId !== row.source_active.bootId ||
          !await this.residentQualified(tx, { ...row, controller_active: input.controller }, witness)) return false;
        const latest = await selectCloudWorkspaceRuntimeUpgrade(tx, { ...sourceScope, runtime: source.runtime, qualificationMode: this.options.qualificationMode });
        if (latest.selected?.pin.runtimeId !== target.runtime.runtimeId) return false;
      }
      const live = () => tx.query(`SELECT 1 FROM cloud_workspaces workspace
        JOIN cloud_workspace_engine_instances engine ON engine.id=$4 AND engine.workspace_id=workspace.id
          AND engine.org_id=workspace.org_id AND engine.generation=$3
        JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=workspace.id
          AND binding.org_id=workspace.org_id AND binding.generation=$3
        WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.current_generation=$3
          AND workspace.desired_state='running' AND workspace.deleted_at IS NULL AND workspace.status IN ('ready','busy')
          AND engine.state='ready' AND engine.lease_expires_at>clock_timestamp()
          AND binding.provider_resource_id=$5 AND binding.observed_state='running'
          AND cloud_workspace_runtime_authority_live(workspace.id,$3,workspace.owner_user_id,$6)
          AND NOT EXISTS(SELECT 1 FROM cloud_workspace_allocation_operations operation
            WHERE operation.workspace_id=workspace.id AND operation.provider_resource_id=$5 AND operation.state<>'completed')
          AND NOT EXISTS(SELECT 1 FROM cloud_workspace_lifecycle_intents intent
            WHERE intent.workspace_id=workspace.id AND intent.state IN ('queued','dispatching','observing'))
          AND NOT EXISTS(SELECT 1 FROM managed_compute_allocation_leases lease WHERE lease.workspace_id=workspace.id
            AND lease.provider_resource_id=$5 AND lease.state<>'settled'
            AND (lease.state<>'active' OR lease.stop_intent_id IS NOT NULL OR lease.lease_expires_at>clock_timestamp()
              OR least(lease.provider_expires_at,lease.funded_until)<=clock_timestamp()+interval '540 seconds'))`,
      [claim.workspaceId,claim.organizationId,row.source_generation,row.source_engine_instance_id,row.provider_resource_id,this.options.workosEnabled]);
      await tx.query(`SELECT id FROM managed_compute_allocation_leases WHERE workspace_id=$1 AND provider_resource_id=$2 FOR UPDATE`, [claim.workspaceId,row.provider_resource_id]);
      if (!(await live()).rowCount || !await input.policy.authorize(tx,claim)) return false;
      // User code may have awaited fresh VM evidence. Recheck the worker and
      // wall-clock bounds under the still-held authority locks before fencing.
      if (!(await this.locked(tx,claim))?.stage_live || !(await live()).rowCount) return false;
      if (resident && !(await tx.query("SELECT 1 WHERE clock_timestamp()<to_timestamp($1::double precision/1000)", [resident.handoff.expiresAtMs])).rowCount) return false;
      await tx.query(`UPDATE cloud_workspace_runtime_transitions SET activation_policy=$2,controller_active=$3::jsonb,
        updated_at=clock_timestamp() WHERE transition_id=$1`, [claim.transitionId,input.policy.id,input.controller ? JSON.stringify(input.controller) : null]);
      if (resident) {
        await tx.query(`INSERT INTO cloud_workspace_runtime_handoffs (transition_id,workspace_id,org_id,execution_fence,phase,
          request,receipt,source_resident,deadline_at) VALUES($1,$2,$3,$4,'consumption_authorized',$5::jsonb,$6::jsonb,$7::jsonb,
          least(to_timestamp($8::double precision/1000),clock_timestamp()+interval '90 seconds'))`,
        [claim.transitionId,claim.workspaceId,claim.organizationId,claim.executionFence,JSON.stringify(resident.handoff),
          JSON.stringify(resident.receipt),JSON.stringify(resident.resident),resident.handoff.expiresAtMs]);
      } else await this.retireSource(tx, claim, row.source_generation);
      return true;
    });
  }

  /** Selection and ownership are shared with RU. Staging is harmless while
   * work continues; activation has a separate, fail-closed injected policy. */
  async offer(input: { workspaceId: string; organizationId: string; generation: number;
    sourceEngineInstanceId: string; operationId: string; mode: "engine" | "bootstrap" }): Promise<CloudRuntimeTransition | null> {
    return withSystemTx(this.options.pool, async tx => {
      await lockCloudWorkspaceGenerationTransition(tx, input);
      const existing = (await tx.query<CloudRuntimeTransition>(`SELECT transition.id AS "transitionId",
        transition.source_generation AS "sourceGeneration",transition.candidate_generation AS "candidateGeneration",
        transition.execution_mode AS "executionMode",coalesce(runtime.phase,'replacement') AS phase
        FROM cloud_workspace_generation_transitions transition
        LEFT JOIN cloud_workspace_runtime_transitions runtime ON runtime.transition_id=transition.id
        WHERE transition.workspace_id=$1 AND transition.org_id=$2
          AND (transition.state IN ('draining','provisioning','setting_up','rolling_back') OR runtime.operation_id=$3)
        ORDER BY transition.candidate_generation DESC LIMIT 1`, [input.workspaceId,input.organizationId,input.operationId])).rows[0];
      if (existing) return existing;
      const source = (await tx.query<{
        owner_user_id: string; staff_role: StaffRole | null; provider_connection_id: string; provider_connection_version: number;
        provider_resource_id: string; runtime_installer_receipt_sha256: string; runtime_boot_id: string;
        runtime_supervisor_session_id: string;
      }>(`SELECT workspace.owner_user_id,account.staff_role,generation.provider_connection_id,generation.provider_connection_version,
        binding.provider_resource_id,engine.runtime_installer_receipt_sha256,engine.runtime_boot_id,engine.runtime_supervisor_session_id
        FROM cloud_workspaces workspace JOIN users account ON account.id=workspace.owner_user_id
        JOIN cloud_workspace_generations generation ON generation.workspace_id=workspace.id
          AND generation.org_id=workspace.org_id AND generation.generation=workspace.current_generation
        JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=workspace.id
          AND binding.org_id=workspace.org_id AND binding.generation=generation.generation
        JOIN cloud_workspace_engine_instances engine ON engine.id=$4 AND engine.workspace_id=workspace.id
          AND engine.org_id=workspace.org_id AND engine.generation=generation.generation
        WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.current_generation=$3
          AND workspace.deleted_at IS NULL AND workspace.desired_state='running' AND workspace.status IN ('ready','busy')
          AND generation.provider='boat' AND generation.runtime_id IS NOT NULL
          AND binding.provider_resource_id IS NOT NULL AND binding.observed_state='running'
          AND engine.state='ready' AND engine.lease_expires_at>clock_timestamp()
          AND cloud_workspace_runtime_authority_live(workspace.id,generation.generation,workspace.owner_user_id,$5)
          AND NOT EXISTS(SELECT 1 FROM cloud_workspace_lifecycle_intents intent WHERE intent.workspace_id=workspace.id
            AND intent.state IN ('queued','dispatching','observing'))
          AND NOT EXISTS(SELECT 1 FROM cloud_workspace_setup_runs setup WHERE setup.workspace_id=workspace.id
            AND setup.state IN ('queued','running'))`,
      [input.workspaceId,input.organizationId,input.generation,input.sourceEngineInstanceId,this.options.workosEnabled])).rows[0];
      if (!source) return null;
      requireOrganizationCreationCapability(source.staff_role);
      if (await readCloudRuntimeResumeProofEpoch(tx,input) !== input.sourceEngineInstanceId) return null;
      const saved = await loadGenerationSource(tx,input);
      const selection = await selectCloudWorkspaceRuntimeUpgrade(tx,{ ...input,runtime:saved.runtime,
        qualificationMode:this.options.qualificationMode });
      if (!selection.updateAvailable || !selection.selected || !saved.runtime) return null;
      const selected = selection.selected;
      const candidateGeneration = (await tx.query<{ generation: number }>(
        "SELECT coalesce(max(generation),0)+1 AS generation FROM cloud_workspace_generations WHERE workspace_id=$1", [input.workspaceId])).rows[0]!.generation;
      const copy = { workspaceId:input.workspaceId,organizationId:input.organizationId,sourceGeneration:input.generation,
        targetGeneration:candidateGeneration,actorUserId:source.owner_user_id };
      await copyGenerationPins(tx,{ ...copy,providerConnectionId:source.provider_connection_id,providerConnectionVersion:source.provider_connection_version,
        qualificationMode:this.options.qualificationMode,runtimeUpgrade:selected.pin });
      const settings = await cloneDatabaseCloudWorkspaceSettingsForRollback(tx,{ ...copy,
        secretEncryptionKeys:this.options.secretEncryptionKeys ?? {},
        currentSecretEncryptionKeyVersion:this.options.currentSecretEncryptionKeyVersion ?? null });
      const persisted = await persistDatabaseCloudWorkspaceSettings(tx,{ ...input,generation:candidateGeneration,
        actorUserId:source.owner_user_id,settings });
      await tx.query(`INSERT INTO cloud_workspace_setup_specs (
        workspace_id,generation,org_id,spec_version,repository_forge,repository_owner,repository_name,
        repository_revision,github_installation_id,settings_snapshot,settings_snapshot_sha256,workspace_settings_version_id)
        SELECT workspace_id,$4,org_id,spec_version,repository_forge,repository_owner,repository_name,
          repository_revision,github_installation_id,$5::jsonb,digest($5::jsonb::text,'sha256'),$6
        FROM cloud_workspace_setup_specs WHERE workspace_id=$1 AND org_id=$2 AND generation=$3`,
      [input.workspaceId,input.organizationId,input.generation,candidateGeneration,persisted.document,persisted.id]);
      await persistCloudWorkspaceSetupSecrets(tx,{ ...input,generation:candidateGeneration,secrets:settings.setupSecrets });
      await tx.query(`INSERT INTO cloud_workspace_provider_bindings(workspace_id,generation,org_id,provider)
        VALUES($1,$3,$2,'boat')`, [input.workspaceId,input.organizationId,candidateGeneration]);
      await tx.query(`INSERT INTO cloud_workspace_allocation_owners (
        workspace_id,org_id,provider_resource_id,original_generation,current_generation,allocation_lease_id)
        VALUES($1,$2,$4,$3,$3,(SELECT id FROM managed_compute_allocation_leases
          WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND provider_resource_id=$4 AND state='active'))
        ON CONFLICT (workspace_id,provider_resource_id) DO UPDATE SET
          allocation_lease_id=coalesce(EXCLUDED.allocation_lease_id,cloud_workspace_allocation_owners.allocation_lease_id)
          WHERE cloud_workspace_allocation_owners.current_generation=EXCLUDED.current_generation`,
      [input.workspaceId,input.organizationId,input.generation,source.provider_resource_id]);
      const transitionId = randomUUID();
      await tx.query(`INSERT INTO cloud_workspace_generation_transitions (
        id,workspace_id,org_id,requested_by,operation,source_generation,template_generation,candidate_generation,state,execution_mode)
        VALUES($1,$2,$3,$4,'upgrade',$5,$5,$6,'draining','retain_allocation')`,
      [transitionId,input.workspaceId,input.organizationId,source.owner_user_id,input.generation,candidateGeneration]);
      const sourceActive = CloudActiveRuntimeSchema.parse({ schema:"zeros.active-runtime/v1",runtimeId:saved.runtime.runtimeId,
        manifestSha256:saved.runtime.manifestSha256,baseCompatibilityId:saved.runtime.baseCompatibilityId,
        installerReceiptSha256:source.runtime_installer_receipt_sha256,bootId:source.runtime_boot_id,
        supervisorSessionId:source.runtime_supervisor_session_id,root:`/opt/zeros-infra/${saved.runtime.runtimeId}`,
        cgroupRoot:"/sys/fs/cgroup/system.slice/zeros-host.service" });
      await tx.query(`INSERT INTO cloud_workspace_runtime_transitions (
        transition_id,workspace_id,org_id,operation_id,source_engine_instance_id,provider_resource_id,mode,source_active,target_descriptor)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
      [transitionId,input.workspaceId,input.organizationId,input.operationId,input.sourceEngineInstanceId,source.provider_resource_id,
        input.mode,JSON.stringify(sourceActive),JSON.stringify(selected.descriptor)]);
      await audit(tx,input.organizationId,null,"cloud_workspace.runtime_transfer_offered",{
        workspaceId:input.workspaceId,transitionId,sourceGeneration:input.generation,candidateGeneration,mode:input.mode });
      return { transitionId,sourceGeneration:input.generation,candidateGeneration,phase:"offered",executionMode:"retain_allocation" };
    });
  }
}
