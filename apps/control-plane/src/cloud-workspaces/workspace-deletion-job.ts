import type { Tx } from "../db.js";

type DeletionJobIntent = {
  workspaceId: string;
  organizationId: string;
  requestedBy: string;
  lifecycleIntentId: string;
};

// The old producer retained a failed predecessor's job key after accepting
// a successor. Only an unambiguous, later accepted request may adopt it;
// timestamps alone do not select among competing requests.
const legacySuccessor = `EXISTS (
  SELECT 1 FROM cloud_workspace_lifecycle_intents successor
  JOIN cloud_workspaces workspace ON workspace.id = successor.workspace_id
    AND workspace.org_id = successor.org_id
  JOIN cloud_workspace_lifecycle_intents predecessor
    ON predecessor.workspace_id = workspace.id AND predecessor.org_id = workspace.org_id
    AND workspace_deletion_jobs.idempotency_key = 'lifecycle.' || predecessor.id::text
  WHERE successor.id = $4::uuid AND successor.workspace_id = $1 AND successor.org_id = $2
    AND successor.requested_by = $3 AND successor.operation = 'delete' AND successor.affects_workspace
    AND successor.generation = workspace.current_generation
    AND successor.state IN ('queued', 'dispatching', 'observing', 'succeeded')
    AND workspace.desired_state = 'deleted' AND workspace.status IN ('deleting', 'deleted')
    AND predecessor.operation = 'delete' AND predecessor.state = 'failed'
    AND predecessor.generation = successor.generation
    AND predecessor.completed_at <= successor.created_at
    AND NOT EXISTS (
      SELECT 1 FROM cloud_workspace_lifecycle_intents other
      WHERE other.workspace_id = workspace.id AND other.org_id = workspace.org_id
        AND other.operation = 'delete' AND other.generation = successor.generation
        AND other.id NOT IN (predecessor.id, successor.id)
    )
)`;

/** Binding-only reconciliation for an already-deleted operator target. Never
 * inserts a job, restarts failed record purge, changes worker progress or leases. */
export async function reconcileWorkspaceDeletionJob(tx: Tx, input: DeletionJobIntent): Promise<void> {
  await tx.query(
    `UPDATE workspace_deletion_jobs
     SET requested_by=$3, idempotency_key='lifecycle.' || $4::uuid::text, updated_at=now()
     WHERE workspace_id=$1 AND org_id=$2 AND ${legacySuccessor}`,
    [input.workspaceId, input.organizationId, input.requestedBy, input.lifecycleIntentId],
  );
}

export async function ensureWorkspaceDeletionJob(
  tx: Tx,
  input: DeletionJobIntent & {
    mode: "accepted" | "replayed";
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO workspace_deletion_jobs (
       workspace_id, org_id, requested_by, idempotency_key
     ) VALUES ($1, $2, $3, 'lifecycle.' || $4::uuid::text)
     ON CONFLICT (workspace_id, org_id) DO UPDATE
     SET requested_by = excluded.requested_by,
         idempotency_key = excluded.idempotency_key,
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
         updated_at = now()
     WHERE $5::boolean OR workspace_deletion_jobs.idempotency_key = excluded.idempotency_key
       OR ${legacySuccessor}`,
    [
      input.workspaceId,
      input.organizationId,
      input.requestedBy,
      input.lifecycleIntentId,
      // New acceptance owns the binding under the workspace mutation lock.
      // Replay normally keeps that binding. The compatibility branch adopts
      // the sole current-generation successor accepted by an old producer
      // after its bound predecessor failed. Ambiguous histories stay closed;
      // timestamps alone must never select among competing requests.
      input.mode === "accepted",
    ],
  );
}
