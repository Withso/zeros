import type pg from "pg";
import { withSystemTx } from "../db.js";
import { cloudFinalSaveErasureAdoptionPending } from "./final-save-erasure.js";

/** Scheduling only: these reads never grant authority or claim work. The
 * existing mutation transaction rechecks every deadline, owner and lease. */
export const recoveryWorkDeadlines = `
  SELECT next_attempt_at AS due_at FROM cloud_workspace_restore_incidents
    WHERE state IN ('queued','waiting_for_capacity','waiting_for_funding','restoring')
  UNION ALL SELECT incident.updated_at+interval '30 days' AS due_at
    FROM cloud_workspace_restore_incidents incident
    JOIN cloud_workspace_generations generation USING(workspace_id,org_id)
    LEFT JOIN cloud_workspace_provider_bindings binding
      ON binding.workspace_id=generation.workspace_id AND binding.generation=generation.generation
    WHERE generation.generation=incident.source_generation AND incident.state IN ('cancelled','succeeded')
      AND (incident.automatic_started_at IS NULL OR (generation.retired_at IS NOT NULL AND binding.deletion_verified_at IS NOT NULL))`;

const deadlines = {
  outbox: `SELECT CASE WHEN state='queued' THEN next_attempt_at ELSE lease_expires_at END AS due_at
    FROM cloud_workspace_outbox WHERE state IN ('queued','processing')`,
  access: `SELECT CASE state WHEN 'active' THEN expires_at WHEN 'issuing' THEN created_at+interval '2 minutes'
      ELSE greatest(next_revocation_at,revocation_lease_expires_at) END AS due_at
    FROM cloud_workspace_client_access_grants WHERE state IN ('active','issuing','revocation_pending')`,
  invitations: `SELECT CASE WHEN delivery.state='sending' THEN delivery.lease_expires_at
      WHEN invitation.revoked_at IS NOT NULL OR invitation.accepted_at IS NOT NULL OR delivery.attempt_count>=12 THEN now()
      ELSE least(delivery.next_attempt_at,invitation.expires_at,delivery.first_attempt_at+interval '23 hours') END AS due_at
    FROM cloud_workspace_invitation_deliveries delivery
    JOIN cloud_workspace_invitations invitation ON invitation.id=delivery.invitation_id
    WHERE delivery.state IN ('queued','sending')`,
  security: `SELECT CASE WHEN delivery_sequence IS NULL THEN now() ELSE expires_at END AS due_at FROM security_events
    UNION ALL SELECT now() AS due_at FROM cloud_workspace_directory_outbox`,
  forks: `SELECT least(fork.deadline_at,CASE
      WHEN fork.operation='cloud_to_local' AND fork.state='requested' AND request.state IN ('failed','expired','cancelled','succeeded') THEN now()
      WHEN fork.operation='cloud_to_local' AND fork.state='exporting' AND request.state='succeeded' THEN fork.lease_expires_at
      END) AS due_at
    FROM workspace_fork_intents fork LEFT JOIN workspace_checkpoint_requests request ON request.fork_intent_id=fork.id
    WHERE fork.state NOT IN ('succeeded','failed','cancelled')`,
  checkpoints: `SELECT deadline_at AS due_at FROM workspace_checkpoint_requests
      WHERE state IN ('queued','delivered','recovery_queued','recovery_delivered')
    UNION ALL SELECT deadline_at FROM workspace_checkpoint_requests
      WHERE state='cancelled' AND error_code='mandatory_capture_cancelled' AND final_save_recovery_id IS NULL`,
  recovery: recoveryWorkDeadlines,
  operations: `SELECT expires_at AS due_at FROM workspace_exports WHERE state='available'
    UNION ALL SELECT expires_at FROM device_request_nonces
    UNION ALL SELECT coalesce(policy.last_applied_at+interval '1 minute',now())
      FROM cloud_workspaces workspace LEFT JOIN workspace_retention_policies policy
        ON policy.workspace_id=workspace.id AND policy.org_id=workspace.org_id
      WHERE workspace.data_deleted_at IS NULL
    UNION ALL SELECT now() FROM cloud_workspaces workspace
      WHERE workspace.desired_state='deleted' AND workspace.data_deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM workspace_deletion_jobs job WHERE job.workspace_id=workspace.id AND job.org_id=workspace.org_id)
    UNION ALL SELECT greatest(job.next_attempt_at,CASE WHEN job.lease_owner IS NOT NULL THEN job.lease_expires_at END)
      FROM workspace_deletion_jobs job JOIN cloud_workspaces workspace ON workspace.id=job.workspace_id AND workspace.org_id=job.org_id
      LEFT JOIN workspace_retention_policies policy ON policy.workspace_id=job.workspace_id AND policy.org_id=job.org_id
      WHERE job.state IN ('waiting_for_provider','deleting_objects','deleting_records')
        AND workspace.status='deleted' AND workspace.data_deleted_at IS NULL AND NOT coalesce(policy.legal_hold,false)
        AND (cloud_final_save_deletion_claimable(workspace.id,workspace.org_id)
          OR (workspace.desired_state='deleted' AND ${cloudFinalSaveErasureAdoptionPending}))
        AND NOT EXISTS (SELECT 1 FROM workspace_blob_references reference JOIN workspace_blobs blob ON blob.id=reference.blob_id AND blob.org_id=reference.org_id
          WHERE reference.workspace_id=job.workspace_id AND reference.org_id=job.org_id AND blob.legal_hold)
        AND NOT EXISTS (SELECT 1 FROM workspace_checkpoints checkpoint WHERE checkpoint.workspace_id=job.workspace_id AND checkpoint.org_id=job.org_id AND checkpoint.legal_hold)
        AND NOT EXISTS (SELECT 1 FROM cloud_workspace_generations generation LEFT JOIN cloud_workspace_provider_bindings binding
          ON binding.workspace_id=generation.workspace_id AND binding.generation=generation.generation AND binding.org_id=generation.org_id
          WHERE generation.workspace_id=job.workspace_id AND generation.org_id=job.org_id AND binding.deletion_verified_at IS NULL)`,
} as const;

export async function readCloudWorkerNextDelay(pool: pg.Pool, worker: keyof typeof deadlines): Promise<number | null> {
  return withSystemTx(pool, async tx => {
    const started = Date.now();
    const result = await tx.query<{ delay_ms: string | null }>(
      `SELECT extract(epoch FROM (min(due_at)-now()))*1000 AS delay_ms FROM (${deadlines[worker]}) work`,
    );
    const delay = result.rows[0]?.delay_ms;
    return delay == null ? null : Number(delay) - (Date.now() - started);
  }, { consistentRead: true });
}
