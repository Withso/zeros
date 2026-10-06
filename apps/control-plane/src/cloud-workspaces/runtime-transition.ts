import type { Tx } from "../db.js";

/** Only the exact successfully enrolled engine of a retained transition may
 * inherit undispatched queue intent. Failed/ordinary replacement engines do
 * not acquire this exception. Dispatched commands remain uncertain. */
export async function isAutomaticRetainedRuntimeEngine(tx: Tx, input: {
  workspaceId: string; organizationId: string; generation: number; engineInstanceId: string;
}): Promise<boolean> {
  return !!(await tx.query(`SELECT 1 FROM cloud_workspace_runtime_enrollments enrollment
    JOIN cloud_workspace_runtime_transitions runtime ON runtime.transition_id=enrollment.transition_id
    JOIN cloud_workspace_generation_transitions transition ON transition.id=runtime.transition_id
    JOIN cloud_workspace_engine_instances engine ON engine.id=enrollment.engine_instance_id
    WHERE enrollment.workspace_id=$1 AND enrollment.org_id=$2 AND enrollment.generation=$3 AND enrollment.engine_instance_id=$4
      AND enrollment.sequence=runtime.enrollment_sequence AND enrollment.consumed_at IS NOT NULL AND enrollment.revoked_at IS NULL
      AND runtime.phase IN ('healthy','rolled_back') AND transition.execution_mode='retain_allocation'
      AND transition.state IN ('succeeded','rolled_back') AND engine.state='ready'
      AND NOT EXISTS(SELECT 1 FROM cloud_workspace_engine_instances newer
        WHERE newer.workspace_id=$1 AND newer.org_id=$2 AND newer.generation=$3 AND newer.enrollment_order>engine.enrollment_order)`,
  [input.workspaceId,input.organizationId,input.generation,input.engineInstanceId])).rowCount;
}

/** The source keeps record/heartbeat authority until root consumes its sealed
 * writer. New queue claims are blocked during that interval under the same
 * workspace lock as the journal commit; enqueue/Stop receipts remain durable. */
export async function cloudRuntimeHandoffBlocksClaims(tx: Tx, input: {
  workspaceId: string; organizationId: string; generation: number; engineInstanceId: string;
}): Promise<boolean> {
  return !!(await tx.query(`SELECT 1 FROM cloud_workspace_runtime_handoffs handoff
    JOIN cloud_workspace_runtime_transitions runtime ON runtime.transition_id=handoff.transition_id
    JOIN cloud_workspace_generation_transitions transition ON transition.id=runtime.transition_id
    WHERE handoff.workspace_id=$1 AND handoff.org_id=$2 AND transition.source_generation=$3
      AND runtime.source_engine_instance_id=$4 AND handoff.phase<>'cancelled'`,
  [input.workspaceId,input.organizationId,input.generation,input.engineInstanceId])).rowCount;
}

/** Cache invalidation only, never admission or qualification. The caller holds
 * the workspace lifecycle lock and checks the full runtime key, current
 * qualification, fresh launch proofs and restored-tree integrity separately.
 * A completed enrollment survives an ordinary same-generation stop. A new
 * enrollment (even one that fails) or unsettled transition invalidates it.
 */
export async function readCloudRuntimeResumeProofEpoch(tx: Tx, input: {
  workspaceId: string;
  organizationId: string;
  generation: number;
}): Promise<string | null> {
  const result = await tx.query<{ id: string }>(`SELECT engine.id
    FROM cloud_workspaces workspace
    JOIN cloud_workspace_generations generation
      ON generation.workspace_id=workspace.id AND generation.org_id=workspace.org_id
      AND generation.generation=workspace.current_generation
    JOIN cloud_workspace_setup_runs setup
      ON setup.workspace_id=generation.workspace_id AND setup.org_id=generation.org_id AND setup.generation=generation.generation
    JOIN cloud_workspace_engine_instances engine
      ON engine.setup_run_id=setup.id AND engine.workspace_id=setup.workspace_id AND engine.org_id=setup.org_id
      AND engine.generation=setup.generation AND engine.setup_execution_fence=setup.execution_fence
    JOIN cloud_workspace_setup_attestations attestation
      ON attestation.setup_run_id=setup.id AND attestation.workspace_id=setup.workspace_id AND attestation.org_id=setup.org_id
      AND attestation.generation=setup.generation AND attestation.execution_fence=setup.execution_fence
      AND attestation.engine_instance_id=engine.id
    WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.current_generation=$3
      AND workspace.deleted_at IS NULL AND workspace.desired_state<>'deleted'
      AND NOT EXISTS(SELECT 1 FROM cloud_workspace_engine_instances newer
        WHERE newer.workspace_id=engine.workspace_id AND newer.org_id=engine.org_id AND newer.generation=engine.generation
          AND newer.runtime_transition_enrollment_id IS NOT NULL AND newer.enrollment_order>engine.enrollment_order)
      AND NOT EXISTS(SELECT 1 FROM cloud_workspace_runtime_transitions runtime
        JOIN cloud_workspace_generation_transitions transition ON transition.id=runtime.transition_id
        JOIN cloud_workspace_engine_instances source_engine ON source_engine.id=runtime.source_engine_instance_id
        WHERE runtime.workspace_id=engine.workspace_id AND runtime.org_id=engine.org_id
          AND transition.source_generation=engine.generation AND runtime.activated_at IS NOT NULL
          AND engine.enrollment_order<=source_engine.enrollment_order)
      AND generation.runtime_id IS NOT NULL AND setup.state='succeeded'
      AND engine.state IN ('ready','revoked') AND engine.registered_at IS NOT NULL
      AND ROW(engine.runtime_id,engine.runtime_manifest_sha256,engine.runtime_base_image_id,
        engine.runtime_base_compatibility_id,engine.runtime_profile,engine.runtime_engine_protocol_version)
        = ROW(generation.runtime_id,generation.runtime_manifest_sha256,generation.runtime_base_image_id,
          generation.runtime_base_compatibility_id,generation.runtime_profile,generation.runtime_engine_protocol_version)
      AND ROW(attestation.runtime_id,attestation.runtime_manifest_sha256,attestation.runtime_base_image_id,
        attestation.runtime_base_compatibility_id,attestation.runtime_profile,attestation.runtime_engine_protocol_version,
        attestation.runtime_installer_receipt_sha256,attestation.runtime_boot_id,attestation.runtime_supervisor_session_id)
        = ROW(engine.runtime_id,engine.runtime_manifest_sha256,engine.runtime_base_image_id,
          engine.runtime_base_compatibility_id,engine.runtime_profile,engine.runtime_engine_protocol_version,
          engine.runtime_installer_receipt_sha256,engine.runtime_boot_id,engine.runtime_supervisor_session_id)
      -- Attempts/fences order enrollment; transaction timestamps do not. Multiple
      -- identities in the same fence are ambiguous, so none may reuse evidence.
      AND NOT EXISTS (
        SELECT 1 FROM cloud_workspace_engine_instances other
        JOIN cloud_workspace_setup_runs other_setup ON other_setup.id=other.setup_run_id
        WHERE other.workspace_id=engine.workspace_id AND other.org_id=engine.org_id AND other.generation=engine.generation
          AND other.id<>engine.id
          AND (other_setup.attempt,other.setup_execution_fence)>=(setup.attempt,engine.setup_execution_fence)
      )
      AND NOT EXISTS (
        SELECT 1 FROM cloud_workspace_generation_transitions transition
        WHERE transition.workspace_id=workspace.id AND transition.org_id=workspace.org_id
          AND ((transition.state NOT IN ('succeeded','rolled_back','cancelled')
            AND (transition.state<>'rollback_failed' OR $3 IN (transition.source_generation,transition.candidate_generation)))
            OR (transition.state='rolled_back' AND transition.source_generation=$3
              AND engine.registered_at<=transition.created_at))
      )`, [input.workspaceId, input.organizationId, input.generation]);
  if (result.rows[0]) return result.rows[0].id;
  const retained=await tx.query<{id:string}>(`SELECT engine.id FROM cloud_workspaces workspace
    JOIN cloud_workspace_generations generation ON generation.workspace_id=workspace.id AND generation.org_id=workspace.org_id
      AND generation.generation=workspace.current_generation
    JOIN cloud_workspace_engine_instances engine ON engine.workspace_id=generation.workspace_id AND engine.org_id=generation.org_id AND engine.generation=generation.generation
    JOIN cloud_workspace_runtime_enrollments enrollment ON enrollment.id=engine.runtime_transition_enrollment_id
    JOIN cloud_workspace_runtime_attestations attestation ON attestation.enrollment_id=enrollment.id AND attestation.engine_instance_id=engine.id
    JOIN cloud_workspace_runtime_transitions runtime ON runtime.transition_id=enrollment.transition_id
    WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.current_generation=$3
      AND workspace.deleted_at IS NULL AND workspace.desired_state<>'deleted'
      AND engine.state IN ('ready','revoked') AND engine.registered_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM cloud_workspace_runtime_transitions later
        JOIN cloud_workspace_generation_transitions transition ON transition.id=later.transition_id
        JOIN cloud_workspace_engine_instances source_engine ON source_engine.id=later.source_engine_instance_id
        WHERE later.workspace_id=engine.workspace_id AND later.org_id=engine.org_id
          AND transition.source_generation=engine.generation AND later.activated_at IS NOT NULL
          AND engine.enrollment_order<=source_engine.enrollment_order)
      AND runtime.phase IN ('healthy','rolled_back') AND enrollment.sequence=runtime.enrollment_sequence
      AND enrollment.consumed_at IS NOT NULL AND enrollment.revoked_at IS NULL
      AND ROW(engine.runtime_id,engine.runtime_manifest_sha256,engine.runtime_base_image_id,
        engine.runtime_base_compatibility_id,engine.runtime_profile,engine.runtime_engine_protocol_version)
        = ROW(generation.runtime_id,generation.runtime_manifest_sha256,generation.runtime_base_image_id,
          generation.runtime_base_compatibility_id,generation.runtime_profile,generation.runtime_engine_protocol_version)
      AND NOT EXISTS(SELECT 1 FROM cloud_workspace_engine_instances newer
        WHERE newer.workspace_id=engine.workspace_id AND newer.org_id=engine.org_id AND newer.generation=engine.generation
          AND newer.enrollment_order>engine.enrollment_order)
      AND NOT EXISTS(SELECT 1 FROM cloud_workspace_generation_transitions transition
        WHERE transition.workspace_id=workspace.id AND transition.org_id=workspace.org_id
          AND transition.state NOT IN ('succeeded','rolled_back','cancelled'))`,[input.workspaceId,input.organizationId,input.generation]);
  return retained.rows[0]?.id??null;
}
