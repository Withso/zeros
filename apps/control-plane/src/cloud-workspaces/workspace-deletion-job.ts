import type { Tx } from "../db.js";

export async function ensureWorkspaceDeletionJob(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    requestedBy: string;
    lifecycleIntentId: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO workspace_deletion_jobs (
       workspace_id, org_id, requested_by, idempotency_key
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, org_id) DO UPDATE
     SET requested_by = excluded.requested_by,
         state = CASE
           WHEN workspace_deletion_jobs.state = 'failed'
             THEN 'waiting_for_provider'
           ELSE workspace_deletion_jobs.state
         END,
         attempt_count = CASE
           WHEN workspace_deletion_jobs.state = 'failed' THEN 0
           ELSE workspace_deletion_jobs.attempt_count
         END,
         error_code = CASE
           WHEN workspace_deletion_jobs.state = 'failed' THEN NULL
           ELSE workspace_deletion_jobs.error_code
         END,
         completed_at = CASE
           WHEN workspace_deletion_jobs.state = 'failed' THEN NULL
           ELSE workspace_deletion_jobs.completed_at
         END,
         next_attempt_at = CASE
           WHEN workspace_deletion_jobs.state = 'failed' THEN now()
           ELSE workspace_deletion_jobs.next_attempt_at
         END,
         updated_at = now()`,
    [
      input.workspaceId,
      input.organizationId,
      input.requestedBy,
      `lifecycle.${input.lifecycleIntentId}`,
    ],
  );
}
