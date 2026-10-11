import type { Tx } from "../db.js";

/** Provider-reported holds retain the existing 24-hour health limit. */
export const PROVIDER_DELETION_WAITING_STAGES = ["waiting_for_uploads", "kept_for_newer_snapshots", "waiting_for_restore"];

/** The health alert and the release deferral share the exact predicates.
 * Parameter positions are fixed literals at their two internal call sites. */
export function stalledDeletionIntentPredicate(waitingStagesParameter: "$1" | "$4"): string {
  return `intent.operation='delete' AND intent.state IN ('queued','dispatching','observing','failed')
    AND binding.deletion_verified_at IS NULL AND operation.deleted_at IS NULL
    AND (intent.state='failed' OR least(intent.created_at,operation.deletion_requested_at)<now()-interval '24 hours'
      OR (coalesce(operation.deletion_progress_at,operation.deletion_requested_at,intent.created_at)<now()-interval '1 hour'
        AND NOT coalesce(operation.deletion_stage,'') = ANY(${waitingStagesParameter}::text[])))`;
}

export function stalledProviderDeletionPredicate(waitingStagesParameter: "$1" | "$4"): string {
  return `operation.deletion_requested_at IS NOT NULL AND operation.deleted_at IS NULL
    AND (operation.deletion_requested_at<now()-interval '24 hours'
      OR (coalesce(operation.deletion_progress_at,operation.deletion_requested_at)<now()-interval '1 hour'
        AND NOT coalesce(operation.deletion_stage,'') = ANY(${waitingStagesParameter}::text[])))`;
}

/** Release readiness only. Once Boat accepts a deletion (a `bdop_` receipt),
 * the retired sandbox has left every list, restore and fork, and its erasure
 * is provider work Zeros cannot advance; health, alerts, capacity reservation
 * and deletion verification keep reporting it. Read-only: a missing receipt,
 * current generation, foreign binding, failed intent or any other stalled
 * resource keeps readiness closed. Provider completion is never fabricated. */
export async function canDeferRetiredBoatDeletions(tx: Tx): Promise<boolean> {
  const result = await tx.query<{ eligible: boolean }>(`WITH stalled_deletions AS (
    SELECT intent.workspace_id,intent.generation,intent.org_id,operation.provider,operation.account_scope,
      intent.state AS intent_state,intent.error_code AS intent_error_code
    FROM cloud_workspace_lifecycle_intents intent
    LEFT JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=intent.workspace_id AND binding.generation=intent.generation AND binding.org_id=intent.org_id
    LEFT JOIN cloud_workspace_provider_operations operation ON operation.workspace_id=intent.workspace_id AND operation.generation=intent.generation AND operation.org_id=intent.org_id
    WHERE ${stalledDeletionIntentPredicate("$1")}
    UNION ALL
    SELECT operation.workspace_id,operation.generation,operation.org_id,operation.provider,operation.account_scope,NULL,NULL
    FROM cloud_workspace_provider_operations operation WHERE ${stalledProviderDeletionPredicate("$1")}
  ) SELECT EXISTS(SELECT 1 FROM stalled_deletions) AND NOT EXISTS(
    SELECT 1 FROM stalled_deletions stalled WHERE NOT EXISTS(
      SELECT 1 FROM cloud_workspace_provider_operations operation
      JOIN cloud_workspace_generations generation ON generation.workspace_id=operation.workspace_id AND generation.generation=operation.generation AND generation.org_id=operation.org_id
      JOIN cloud_workspaces workspace ON workspace.id=operation.workspace_id AND workspace.org_id=operation.org_id
      JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=operation.workspace_id AND binding.generation=operation.generation AND binding.org_id=operation.org_id
      WHERE operation.workspace_id=stalled.workspace_id AND operation.generation=stalled.generation AND operation.org_id=stalled.org_id
        AND operation.provider=stalled.provider AND operation.account_scope=stalled.account_scope
        AND operation.provider='boat'
        AND operation.deletion_requested_at IS NOT NULL AND operation.deletion_operation_id ~ '^bdop_[a-f0-9]{32}$'
        AND operation.deleted_at IS NULL AND generation.provider='boat' AND generation.retired_at IS NOT NULL AND workspace.current_generation<>generation.generation
        AND binding.provider='boat' AND binding.provider_resource_id=operation.resource_id AND binding.observed_state='archived' AND binding.deletion_verified_at IS NULL
        AND binding.provider_connection_id=generation.provider_connection_id AND binding.provider_connection_version=generation.provider_connection_version
        AND (stalled.intent_state IS NULL OR (stalled.intent_state='observing'
          AND (stalled.intent_error_code IS NULL OR stalled.intent_error_code IN ('provider_deletion_blocked','provider_deletion_pending'))))
        AND EXISTS(SELECT 1 FROM cloud_workspace_lifecycle_intents intent
          WHERE intent.workspace_id=operation.workspace_id AND intent.generation=operation.generation AND intent.org_id=operation.org_id
            AND intent.operation='delete' AND intent.state='observing'
            AND (intent.error_code IS NULL OR intent.error_code IN ('provider_deletion_blocked','provider_deletion_pending')))
    )
  ) AS eligible`, [PROVIDER_DELETION_WAITING_STAGES]);
  return result.rows[0]?.eligible === true;
}
