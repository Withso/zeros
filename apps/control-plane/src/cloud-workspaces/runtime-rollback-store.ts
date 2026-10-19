import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { lockCloudWorkspaceGenerationTransition } from "./generation-transitions.js";
import { CloudActiveRuntimeSchema, RuntimeDescriptorSchema, type CloudActiveRuntime } from "./runtime-contract.js";
import { parseRuntimeRollbackOffer, type RuntimeRollbackOffer, type RuntimeRollbackScope } from "./runtime-rollback-contract.js";
import type { RuntimeArtifactStore } from "./runtime-artifact-store.js";

export type RuntimeRollbackStopClaim = RuntimeRollbackScope & { workerId: string; sourceBindingId: string | null };
export type RuntimeRollbackStopPlan = { scope: RuntimeRollbackScope; current: CloudActiveRuntime; expiresAt: string };
const values = (c: RuntimeRollbackStopClaim) => [c.workspaceId,c.organizationId,c.generation,c.providerResourceId,
  c.intentId,c.authorityEpoch,c.workerId,c.sourceBindingId];
const scopeOf = ({ workerId: _worker, sourceBindingId: _binding, ...scope }: RuntimeRollbackStopClaim) => scope;
const same = (a: object, b: object) => Object.entries(a).every(([key, value]) => (b as Record<string, unknown>)[key] === value);
const currentStop = `FROM cloud_workspaces workspace
  JOIN cloud_workspace_lifecycle_intents intent ON intent.workspace_id=workspace.id AND intent.org_id=workspace.org_id
  JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=workspace.id AND binding.org_id=workspace.org_id AND binding.generation=$3
  WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.current_generation=$3 AND workspace.authority_epoch=$6
    AND workspace.agent_boot_id IS NOT DISTINCT FROM $8::uuid AND workspace.desired_state='stopped' AND workspace.deleted_at IS NULL
    AND intent.id=$5 AND intent.generation=$3 AND intent.operation='stop' AND intent.affects_workspace
    AND intent.state='dispatching' AND intent.lease_owner=$7 AND intent.lease_expires_at>clock_timestamp()
    AND binding.provider='boat' AND binding.provider_resource_id=$4 AND binding.deletion_verified_at IS NULL`;

/** DB locks cover decisions only. Every remote read is followed by a new
 * locked scope check. The retention ACK is returned only after COMMIT. */
export class DatabaseRuntimeRollbackStore {
  constructor(private readonly options: { pool: pg.Pool; artifacts: Pick<RuntimeArtifactStore,"head"> }) {}

  isStopCurrent(claim: RuntimeRollbackStopClaim): Promise<boolean> {
    return withSystemTx(this.options.pool, async tx => {
      await lockCloudWorkspaceGenerationTransition(tx, claim);
      return !!(await tx.query(`SELECT 1 ${currentStop}`, values(claim))).rowCount;
    });
  }

  readStop(claim: RuntimeRollbackStopClaim): Promise<RuntimeRollbackStopPlan | null> {
    return withSystemTx(this.options.pool, tx => this.readStopTx(tx, claim));
  }

  private async readStopTx(tx: Tx, claim: RuntimeRollbackStopClaim): Promise<RuntimeRollbackStopPlan | null> {
    await lockCloudWorkspaceGenerationTransition(tx, claim);
    const stop = (await tx.query<{ expires_at: Date }>(`SELECT least(intent.dispatched_at+interval '120 seconds',
      intent.lease_expires_at-interval '5 seconds',
      coalesce((SELECT min(least(lease.funded_until,lease.provider_expires_at))-interval '45 seconds'
        FROM managed_compute_allocation_leases lease
        WHERE lease.workspace_id=$1 AND lease.org_id=$2 AND lease.provider_resource_id=$4 AND lease.state<>'settled'
          AND lease.funded_until IS NOT NULL AND lease.provider_expires_at IS NOT NULL),clock_timestamp())) AS expires_at
      ${currentStop} AND binding.observed_state='running' AND intent.dispatched_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM workspace_checkpoint_requests request WHERE request.lifecycle_intent_id=intent.id
        AND request.workspace_id=$1 AND request.org_id=$2 AND request.generation=$3 AND request.state='succeeded')
      AND NOT EXISTS(SELECT 1 FROM cloud_workspace_generation_transitions transition
        WHERE transition.workspace_id=$1 AND transition.org_id=$2 AND transition.state IN ('draining','provisioning','setting_up','rolling_back'))
      AND NOT EXISTS(SELECT 1 FROM cloud_workspace_runtime_transitions runtime
        WHERE runtime.workspace_id=$1 AND runtime.org_id=$2 AND runtime.phase NOT IN ('healthy','rolled_back','cancelled'))`, values(claim))).rows[0];
    if (!stop || stop.expires_at.getTime() <= Date.now() + 5000) return null;
    const row = (await tx.query<{ runtime_id: string; runtime_manifest_sha256: string; runtime_base_compatibility_id: string;
      runtime_installer_receipt_sha256: string; runtime_boot_id: string; runtime_supervisor_session_id: string }>(`SELECT engine.*
      FROM cloud_workspace_engine_instances engine
      JOIN cloud_workspace_generations generation ON generation.workspace_id=engine.workspace_id AND generation.org_id=engine.org_id
        AND generation.generation=engine.generation AND generation.runtime_id=engine.runtime_id
      JOIN cloud_runtime_base_contracts base ON base.base_compatibility_id=generation.runtime_base_compatibility_id
      JOIN provider_connections connection ON connection.id=generation.provider_connection_id AND connection.org_id=engine.org_id
      JOIN provider_connection_versions version ON version.connection_id=connection.id AND version.org_id=connection.org_id
        AND version.version=generation.provider_connection_version
      WHERE engine.workspace_id=$1 AND engine.org_id=$2 AND engine.generation=$3
        AND base.contract->'runtimeRollbackCacheVersion'='1'::jsonb AND base.revoked_at IS NULL
        AND generation.provider='boat' AND connection.state='active' AND connection.credential_source='hosted'
        AND version.credential_source='hosted' AND version.retired_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM cloud_workspace_engine_instances newer WHERE newer.workspace_id=$1 AND newer.org_id=$2
          AND newer.generation=$3 AND newer.enrollment_order>engine.enrollment_order)
        AND EXISTS(SELECT 1 FROM cloud_workspace_local_command_writers writer WHERE writer.workspace_id=$1 AND writer.org_id=$2
          AND writer.generation=$3 AND writer.engine_instance_id=engine.id AND writer.boot_id=engine.runtime_boot_id
          AND writer.activated_at IS NOT NULL AND writer.sealed_sequence IS NOT NULL AND writer.seal_ack IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM cloud_workspace_local_command_writers open_writer WHERE open_writer.workspace_id=$1
            AND open_writer.org_id=$2 AND open_writer.state='active' AND open_writer.sealed_sequence IS NULL))
        AND (EXISTS(SELECT 1 FROM cloud_workspace_setup_attestations attestation
          JOIN cloud_workspace_setup_runs run ON run.id=attestation.setup_run_id AND run.state='succeeded'
          WHERE attestation.engine_instance_id=engine.id AND attestation.workspace_id=$1 AND attestation.org_id=$2 AND attestation.generation=$3)
        OR EXISTS(SELECT 1 FROM cloud_workspace_runtime_enrollments enrollment
          JOIN cloud_workspace_runtime_transitions runtime ON runtime.transition_id=enrollment.transition_id
          JOIN cloud_workspace_runtime_attestations attestation ON attestation.enrollment_id=enrollment.id AND attestation.engine_instance_id=engine.id
          WHERE enrollment.engine_instance_id=engine.id AND enrollment.workspace_id=$1 AND enrollment.org_id=$2
            AND enrollment.generation=$3 AND runtime.phase IN ('healthy','rolled_back')))`, values(claim).slice(0,3))).rows[0];
    if (!row) return null;
    const active = CloudActiveRuntimeSchema.safeParse({ schema: "zeros.active-runtime/v1", runtimeId: row.runtime_id,
      manifestSha256: row.runtime_manifest_sha256, baseCompatibilityId: row.runtime_base_compatibility_id,
      installerReceiptSha256: row.runtime_installer_receipt_sha256, bootId: row.runtime_boot_id,
      supervisorSessionId: row.runtime_supervisor_session_id, root: `/opt/zeros-infra/${row.runtime_id}`,
      cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service" });
    return active.success ? { scope: scopeOf(claim), current: active.data, expiresAt: stop.expires_at.toISOString() } : null;
  }

  async authorize(claim: RuntimeRollbackStopClaim, expected: RuntimeRollbackStopPlan): Promise<boolean> {
    const current = await this.readStop(claim);
    return !!current && same(current.current, expected.current) && same(current.scope, expected.scope) &&
      Date.parse(expected.expiresAt) > Date.now() && Date.parse(current.expiresAt) >= Date.parse(expected.expiresAt);
  }

  async retain(claim: RuntimeRollbackStopClaim, raw: RuntimeRollbackOffer, signal?: AbortSignal): Promise<string | null> {
    let offer: RuntimeRollbackOffer;
    try { offer = parseRuntimeRollbackOffer(raw); } catch { return null; }
    const matches = (plan: RuntimeRollbackStopPlan | null) => plan && same(plan.scope,offer.scope) &&
      plan.current.runtimeId === offer.currentRuntimeId && plan.current.bootId === offer.bootId &&
      plan.current.baseCompatibilityId === offer.baseCompatibilityId;
    const before = await withSystemTx(this.options.pool, async tx => {
      if (!matches(await this.readStopTx(tx,claim))) return null;
      const row = (await tx.query<{ descriptor: unknown; object_key: string }>(`SELECT object_key,jsonb_build_object(
        'runtimeId',runtime_id,'manifestSha256',manifest_sha256,'archiveSha256',archive_sha256,'archiveBytes',archive_bytes,
        'expandedBytes',expanded_bytes,'sourceCommit',source_commit,'nodeModulesAbi',node_modules_abi,
        'bootstrapProtocolVersion',bootstrap_protocol_version,'engineProtocolVersion',engine_protocol_version) AS descriptor
        FROM cloud_runtime_bundles WHERE runtime_id=$1`, [offer.runtime.runtimeId])).rows[0];
      const parsed = RuntimeDescriptorSchema.safeParse(row?.descriptor);
      return row && parsed.success && same(offer.runtime,parsed.data) ? row.object_key : null;
    });
    if (!before || signal?.aborted) return null;
    const object = await this.options.artifacts.head(before, signal);
    if (signal?.aborted || !object.exists || object.bytes !== offer.runtime.archiveBytes) return null;
    return withSystemTx(this.options.pool, async tx => {
      if (signal?.aborted || !matches(await this.readStopTx(tx,claim))) return null;
      await tx.query(`INSERT INTO cloud_workspace_runtime_rollback_refs(workspace_id,org_id,generation,provider_resource_id,intent_id,
        runtime_id,base_compatibility_id,proof) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(workspace_id,intent_id,runtime_id) DO NOTHING`, [claim.workspaceId,claim.organizationId,claim.generation,
        claim.providerResourceId,claim.intentId,offer.runtime.runtimeId,offer.baseCompatibilityId,JSON.stringify(offer)]);
      const saved = (await tx.query<{ id: string; proof: unknown }>(`SELECT id,proof FROM cloud_workspace_runtime_rollback_refs
        WHERE workspace_id=$1 AND org_id=$2 AND intent_id=$3 AND runtime_id=$4`,
      [claim.workspaceId,claim.organizationId,claim.intentId,offer.runtime.runtimeId])).rows[0];
      return saved && JSON.stringify(parseRuntimeRollbackOffer(saved.proof)) === JSON.stringify(offer) ? saved.id : null;
    });
  }
}
