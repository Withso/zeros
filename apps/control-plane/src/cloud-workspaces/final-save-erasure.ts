import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { ensureFinalSaveRecovery } from "./final-save-recovery.js";

// Same admission rule as 0171: a reversible unsuccessful idle attempt has no
// durable recovery owner. The existing SQL erasure guard checks its exact
// retired-request exception; this scheduling hint grants no erasure authority.
const missingHistory = `intent.operation IN ('stop','archive','delete')
  AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries recovery WHERE recovery.lifecycle_intent_id=intent.id)
  AND (intent.idempotency_key NOT LIKE 'system:idle:%' OR cloud_workspace_drain_is_mandatory(intent.id)
    OR EXISTS (SELECT 1 FROM workspace_checkpoint_requests request WHERE request.lifecycle_intent_id=intent.id AND request.state='succeeded'))`;

/** Aliases the same workspace as the operations deadline/claim query. A
 * missing legacy owner must be encountered before the claimability filter. */
export const cloudFinalSaveErasureAdoptionPending = `EXISTS (
  SELECT 1 FROM cloud_workspace_lifecycle_intents intent
  WHERE intent.workspace_id=workspace.id AND intent.org_id=workspace.org_id AND ${missingHistory})`;

const providerRetired = `workspace.status='deleted' AND workspace.desired_state='deleted' AND workspace.data_deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM cloud_workspace_generations generation
    LEFT JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=generation.workspace_id
      AND binding.org_id=generation.org_id AND binding.generation=generation.generation
    WHERE generation.workspace_id=workspace.id AND generation.org_id=workspace.org_id AND binding.deletion_verified_at IS NULL)`;

const adoptionCandidate = `job.state IN ('waiting_for_provider','deleting_objects','deleting_records')
  AND job.next_attempt_at<=clock_timestamp() AND (job.lease_owner IS NULL OR job.lease_expires_at<=clock_timestamp())
  AND ${providerRetired}
  AND NOT EXISTS (SELECT 1 FROM workspace_retention_policies policy
    WHERE policy.workspace_id=workspace.id AND policy.org_id=workspace.org_id AND policy.legal_hold)
  AND NOT EXISTS (SELECT 1 FROM workspace_checkpoints checkpoint
    WHERE checkpoint.workspace_id=workspace.id AND checkpoint.org_id=workspace.org_id AND checkpoint.legal_hold)
  AND NOT EXISTS (SELECT 1 FROM workspace_blob_references reference JOIN workspace_blobs blob ON blob.id=reference.blob_id AND blob.org_id=reference.org_id
    WHERE reference.workspace_id=workspace.id AND reference.org_id=workspace.org_id AND blob.legal_hold)
  AND ${cloudFinalSaveErasureAdoptionPending}`;

/** Caller holds organization -> workspace. This is historical erasure custody,
 * never current dispatch proof. An older enrolled source keeps its own receipt
 * and immutable identity, behind a later exact saved Delete in that generation
 * and positive physical retirement. The SQL live-proof function is unchanged. */
export async function resolveHistoricalFinalSaveForErasure(tx: Tx, intentId: string): Promise<boolean> {
  const result = await tx.query(`UPDATE cloud_workspace_final_save_recoveries recovery
    SET state='resolved',proven_request_id=request.id,checkpoint_id=request.checkpoint_id,
      last_checked_at=clock_timestamp(),updated_at=clock_timestamp()
    FROM cloud_workspace_lifecycle_intents intent
    JOIN cloud_workspaces workspace ON workspace.id=intent.workspace_id AND workspace.org_id=intent.org_id
    JOIN workspace_checkpoint_requests request ON request.lifecycle_intent_id=intent.id
      AND request.workspace_id=intent.workspace_id AND request.org_id=intent.org_id AND request.generation=intent.generation
    JOIN workspace_checkpoints checkpoint ON checkpoint.id=request.checkpoint_id
      AND checkpoint.workspace_id=request.workspace_id AND checkpoint.org_id=request.org_id AND checkpoint.generation=request.generation
    JOIN cloud_workspace_engine_instances engine ON engine.workspace_id=intent.workspace_id
      AND engine.org_id=intent.org_id AND engine.generation=intent.generation
    JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=intent.workspace_id
      AND binding.org_id=intent.org_id AND binding.generation=intent.generation
    WHERE recovery.lifecycle_intent_id=$1 AND recovery.lifecycle_intent_id=intent.id
      AND recovery.workspace_id=intent.workspace_id AND recovery.org_id=intent.org_id
      AND recovery.generation=intent.generation AND recovery.operation=intent.operation::text
      AND recovery.state NOT IN ('proven','resolved') AND intent.state='succeeded'
      AND request.id=recovery.original_request_id AND request.id=recovery.current_request_id
      AND request.state='succeeded' AND request.completed_at IS NOT NULL
      AND (request.reason='before_'||recovery.operation OR (recovery.operation='stop' AND request.reason='before_rebuild'
        AND EXISTS (SELECT 1 FROM cloud_workspace_generation_transitions transition WHERE transition.drain_intent_id=intent.id)))
      AND checkpoint.reason=request.reason AND checkpoint.state='durable' AND checkpoint.invalidated_at IS NULL
      AND checkpoint.durable_at IS NOT NULL AND checkpoint.authority_epoch=recovery.authority_epoch
      AND engine.id=recovery.engine_instance_id AND engine.registered_at=recovery.registered_at
      AND engine.heartbeat_token_hash=recovery.registration_token_sha256 AND engine.runtime_id IS NOT DISTINCT FROM recovery.runtime_id
      AND engine.registered_at<=checkpoint.durable_at AND engine.registered_at<=engine.final_checkpoint_at
      AND engine.final_checkpoint_at IS NOT NULL AND (recovery.boot_id IS NULL OR engine.runtime_boot_id=recovery.boot_id)
      AND binding.provider_resource_id=recovery.provider_resource_id
      AND (recovery.allocation_lease_id IS NULL OR EXISTS (SELECT 1 FROM managed_compute_allocation_leases lease
        WHERE lease.id=recovery.allocation_lease_id AND lease.workspace_id=recovery.workspace_id AND lease.org_id=recovery.org_id
          AND lease.provider_resource_id=recovery.provider_resource_id))
      AND (coalesce(engine.cloud_local_commands_version,0)<>1 OR EXISTS (
        SELECT 1 FROM cloud_workspace_local_command_writers writer WHERE writer.workspace_id=recovery.workspace_id
          AND writer.org_id=recovery.org_id AND writer.generation=recovery.generation AND writer.engine_instance_id=engine.id
          AND writer.boot_id=recovery.boot_id AND writer.writer_epoch=recovery.writer_epoch
          AND writer.funding_owner_user_id=recovery.funding_owner_user_id AND writer.funding_owner_epoch=recovery.funding_owner_epoch
          AND writer.activated_at IS NOT NULL AND writer.sealed_sequence IS NOT NULL AND writer.seal_ack IS NOT NULL))
      AND ${providerRetired}
      AND EXISTS (SELECT 1 FROM workspace_deletion_jobs job WHERE job.workspace_id=workspace.id AND job.org_id=workspace.org_id
        AND job.state IN ('waiting_for_provider','deleting_objects','deleting_records'))
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches held
        WHERE held.workspace_id=workspace.id AND held.org_id=workspace.org_id AND held.settled_at IS NULL)
      AND EXISTS (
        SELECT 1 FROM cloud_workspace_final_save_recoveries saved
        JOIN cloud_workspace_lifecycle_intents deletion ON deletion.id=saved.lifecycle_intent_id
          AND deletion.workspace_id=saved.workspace_id AND deletion.org_id=saved.org_id AND deletion.generation=saved.generation
        JOIN cloud_workspace_engine_instances successor ON successor.id=saved.engine_instance_id
          AND successor.workspace_id=saved.workspace_id AND successor.org_id=saved.org_id AND successor.generation=saved.generation
        JOIN cloud_workspace_final_save_dispatches dispatch ON dispatch.lifecycle_intent_id=deletion.id
        WHERE saved.workspace_id=workspace.id AND saved.org_id=workspace.org_id AND saved.generation=workspace.current_generation
          AND saved.generation=recovery.generation AND saved.operation='delete' AND saved.state='proven'
          AND deletion.state='succeeded' AND successor.enrollment_order>engine.enrollment_order
          AND deletion.created_at>=intent.completed_at AND cloud_final_save_proven(deletion.id)
          AND ROW(dispatch.workspace_id,dispatch.org_id,dispatch.generation,dispatch.provider_resource_id,
            dispatch.allocation_lease_id,dispatch.engine_instance_id,dispatch.boot_id)
            IS NOT DISTINCT FROM ROW(saved.workspace_id,saved.org_id,saved.generation,saved.provider_resource_id,
              saved.allocation_lease_id,saved.engine_instance_id,saved.boot_id)
          AND dispatch.settled_at>=dispatch.admitted_at AND binding.deletion_verified_at>=dispatch.admitted_at)
    RETURNING recovery.lifecycle_intent_id`, [intentId]);
  return result.rowCount === 1;
}

/** Bounded adoption of an already provider-retired job. Missing rows are
 * created once; unproved ones keep the existing durable recovery/backoff owner.
 * No claim, attempt reset, provider call or new lifecycle action occurs here. */
export async function adoptFinalSaveErasureHistory(pool: pg.Pool): Promise<boolean> {
  return withSystemTx(pool, async tx => {
    const candidate = (await tx.query<{ id: string; workspace_id: string; org_id: string }>(`SELECT job.id,job.workspace_id,job.org_id
      FROM workspace_deletion_jobs job JOIN cloud_workspaces workspace ON workspace.id=job.workspace_id AND workspace.org_id=job.org_id
      JOIN organizations organization ON organization.id=workspace.org_id
      WHERE ${adoptionCandidate} ORDER BY job.next_attempt_at,job.created_at,job.id
      FOR SHARE OF organization SKIP LOCKED LIMIT 1`)).rows[0];
    if (!candidate) return false;
    if (!(await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE SKIP LOCKED",
      [candidate.workspace_id,candidate.org_id])).rowCount) return false;
    // Re-read every scheduling precondition after the parent lock. Another
    // worker or a legal hold may have changed it during lock acquisition.
    if (!(await tx.query(`SELECT job.id FROM workspace_deletion_jobs job
      JOIN cloud_workspaces workspace ON workspace.id=job.workspace_id AND workspace.org_id=job.org_id
      WHERE job.id=$1 AND ${adoptionCandidate} FOR UPDATE OF job SKIP LOCKED`, [candidate.id])).rowCount) return false;
    const intents = await tx.query<{ id: string }>(`SELECT intent.id FROM cloud_workspace_lifecycle_intents intent
      WHERE intent.workspace_id=$1 AND intent.org_id=$2 AND ${missingHistory}
      ORDER BY intent.created_at,intent.id LIMIT 8 FOR UPDATE OF intent`, [candidate.workspace_id,candidate.org_id]);
    for (const intent of intents.rows) {
      await ensureFinalSaveRecovery(tx, intent.id);
      await resolveHistoricalFinalSaveForErasure(tx, intent.id);
    }
    return intents.rows.length > 0;
  });
}
