import { createHash, randomUUID } from "node:crypto";
import type { Tx } from "../db.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";
import { recordCloudWorkspaceStopUnsealed } from "./stop-seal.js";

type WakeDrain = { id: string; failed: boolean; capturePending: boolean };

/** Caller holds the exact current workspace lock. A wake may replace the
 * desired state, never the provider drain which makes its source recoverable.
 * This helper only requests retirement; positive provider proof still owns it. */
export async function preserveCloudWorkspaceWakeDrain(tx: Tx, input: {
  workspaceId: string; organizationId: string; generation: number;
  retireSource: boolean; retryFailed: boolean; sourceBefore?: Date;
}): Promise<WakeDrain | null> {
  const source = (await tx.query<{ id: string; created_at: Date }>(`SELECT binding.id,binding.created_at
    FROM cloud_workspaces workspace JOIN cloud_agent_boot_bindings binding
      ON binding.id=workspace.agent_boot_id AND binding.workspace_id=workspace.id AND binding.org_id=workspace.org_id
    WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.current_generation=$3
      AND binding.generation=$3 AND binding.retired_at IS NULL
      AND ($4::timestamptz IS NULL OR binding.created_at<=$4)`,
  [input.workspaceId, input.organizationId, input.generation, input.sourceBefore ?? null])).rows[0];
  const drain = (await tx.query<{
    id: string; state: string; capture_pending: boolean;
    checkpoint_id: string | null; checkpoint_state: string | null; checkpoint_error: string | null; checkpoint_live: boolean;
  }>(`SELECT intent.id,intent.state,
      request.id AS checkpoint_id,request.state AS checkpoint_state,request.error_code AS checkpoint_error,
      coalesce(request.deadline_at>clock_timestamp(),false) AS checkpoint_live,
      coalesce(request.state IN ('queued','delivered','cancelled') AND request.error_code IS DISTINCT FROM 'stop_unsealed'
        AND request.deadline_at>clock_timestamp(),false) AS capture_pending
    FROM cloud_workspace_lifecycle_intents intent
    LEFT JOIN workspace_checkpoint_requests request ON request.lifecycle_intent_id=intent.id
    WHERE intent.workspace_id=$1 AND intent.org_id=$2 AND intent.generation=$3
      AND intent.operation IN ('stop','archive') AND intent.state IN ('queued','observing','dispatching','failed','superseded')
      AND (cloud_workspace_drain_is_mandatory(intent.id) OR ($4 AND intent.created_at>=$5))
      AND (intent.state IN ('queued','observing','dispatching') OR intent.created_at>=$5
        OR (request.state='succeeded' AND NOT EXISTS (SELECT 1 FROM cloud_workspace_engine_instances engine
          WHERE engine.workspace_id=$1 AND engine.org_id=$2 AND engine.generation=$3 AND engine.created_at>request.completed_at))
        OR EXISTS (SELECT 1 FROM managed_compute_allocation_leases lease
          WHERE lease.workspace_id=$1 AND lease.org_id=$2 AND lease.stop_intent_id=intent.id AND lease.state IN ('draining','settled')
            AND (lease.state='draining' OR NOT EXISTS (SELECT 1 FROM cloud_workspace_engine_instances engine
              WHERE engine.workspace_id=$1 AND engine.org_id=$2 AND engine.generation=$3 AND engine.created_at>intent.created_at))))
    ORDER BY (intent.state IN ('queued','observing','dispatching')) DESC,intent.created_at DESC,intent.id
    LIMIT 1 FOR UPDATE OF intent`,
  [input.workspaceId, input.organizationId, input.generation, input.retireSource && !!source, source?.created_at ?? null])).rows[0];
  if (drain) {
    const terminal = ["failed", "superseded"].includes(drain.state);
    if (terminal && !input.retryFailed) return { id: drain.id, failed: true, capturePending: false };
    if (terminal && drain.checkpoint_id && drain.checkpoint_state !== "succeeded" && drain.checkpoint_error !== "stop_unsealed") {
      // A fresh owner retry must not strand the same drain behind an expired
      // request written before cancellation preservation. Keep its deadline.
      await tx.query(`UPDATE workspace_checkpoint_requests SET state='cancelled',completed_at=coalesce(completed_at,now()),
        error_code=$2 WHERE id=$1`, [drain.checkpoint_id, drain.checkpoint_live ? "mandatory_capture_cancelled" : "stop_unsealed"]);
      drain.capture_pending = drain.checkpoint_live;
      if (!drain.checkpoint_live) await recordCloudWorkspaceStopUnsealed(tx, {
        ...input, intentId: drain.id, checkpointRequestId: drain.checkpoint_id, reason: "seal_deadline",
      });
    }
    // Keep an active provider backoff and lease intact. Only a new explicit
    // retry can requeue a terminal failure; it keeps the same source/deadline.
    await tx.query(`UPDATE cloud_workspace_lifecycle_intents SET affects_workspace=false,
      state=CASE WHEN $2 THEN 'queued'::cloud_workspace_intent_state ELSE state END,
      next_attempt_at=CASE WHEN $2 THEN now() ELSE next_attempt_at END,
      completed_at=NULL,error_code=CASE WHEN $2 THEN NULL ELSE error_code END,
      error_message=CASE WHEN $2 THEN NULL ELSE error_message END,
      lease_owner=CASE WHEN $2 THEN NULL ELSE lease_owner END,
      lease_expires_at=CASE WHEN $2 THEN NULL ELSE lease_expires_at END,updated_at=now() WHERE id=$1`,
    [drain.id, terminal]);
    if (!drain.capture_pending) await retireCloudWorkspaceRuntimeAccess(tx, {
      ...input, reason: "workspace_stop_requested",
    });
    return { id: drain.id, failed: false, capturePending: drain.capture_pending };
  }
  if (!input.retireSource || !source) return null;
  await retireCloudWorkspaceRuntimeAccess(tx, { ...input, reason: "workspace_stop_requested" });
  const id = randomUUID();
  const key = `system:wake-drain:${id}`;
  await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
    (id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,affects_workspace)
    VALUES($1,$2,$3,$4,'stop',$5,$6,false)`,
  [id, input.workspaceId, input.generation, input.organizationId, key,
    createHash("sha256").update(JSON.stringify({ key, sourceBindingId: source.id })).digest()]);
  return { id, failed: false, capturePending: false };
}

/** Link before releasing the claim. A failed automatic prerequisite stays
 * visible until a fresh owner request explicitly retries it. */
export async function deferCloudWorkspaceWakeForDrain(tx: Tx, intentId: string, drain: WakeDrain): Promise<void> {
  await tx.query(`UPDATE cloud_workspace_lifecycle_intents SET resume_after_intent_id=$2,
    state=CASE WHEN $3 THEN 'failed'::cloud_workspace_intent_state ELSE 'queued'::cloud_workspace_intent_state END,
    completed_at=CASE WHEN $3 THEN now() ELSE NULL END,lease_owner=NULL,lease_expires_at=NULL,
    error_code=CASE WHEN $3 THEN 'workspace_drain_failed' ELSE NULL END,
    error_message=CASE WHEN $3 THEN 'The previous engine could not be stopped. Retry starting the workspace.' ELSE NULL END,
    updated_at=now() WHERE id=$1`, [intentId, drain.id, drain.failed]);
  if (drain.failed) await tx.query(`UPDATE cloud_workspaces workspace SET status='failed',last_error_code='workspace_drain_failed',
    last_error_message='The previous engine could not be stopped. Retry starting the workspace.',version=version+1,updated_at=now()
    FROM cloud_workspace_lifecycle_intents intent WHERE intent.id=$1 AND workspace.id=intent.workspace_id
      AND workspace.org_id=intent.org_id AND workspace.current_generation=intent.generation AND workspace.desired_state='running'`, [intentId]);
}
