import { z } from "zod";
import type { Tx } from "../db.js";

const MAX_EXCEPTION_MS = 72 * 60 * 60_000;
const ExceptionSchema = z.object({
  startsAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  sandboxIds: z.array(z.string().regex(/^bx_[a-z0-9]+$/)).min(1).max(7),
}).strict().refine(value => new Set(value.sandboxIds).size === value.sandboxIds.length &&
  Date.parse(value.expiresAt) > Date.parse(value.startsAt) &&
  Date.parse(value.expiresAt) - Date.parse(value.startsAt) <= MAX_EXCEPTION_MS);

export type AlphaDeletionReadinessException = z.infer<typeof ExceptionSchema>;

export function loadAlphaDeletionReadinessException(env: NodeJS.ProcessEnv, channel: string): AlphaDeletionReadinessException | null {
  const raw = env.ALPHA_DELETION_READINESS_EXCEPTION_JSON;
  if (channel !== "alpha" || !raw?.trim()) return null;
  try {
    if (raw.length > 4096) throw new Error();
    return ExceptionSchema.parse(JSON.parse(raw));
  } catch {
    // Private resource identities and JSON excerpts must not enter boot logs.
    throw new Error("Invalid Alpha deletion readiness exception");
  }
}

export function activeAlphaDeletionReadinessException(
  value: AlphaDeletionReadinessException | null | undefined, channel: string, now = Date.now(),
): AlphaDeletionReadinessException | null {
  if (channel !== "alpha") return null;
  const parsed = ExceptionSchema.safeParse(value);
  return parsed.success && Date.parse(parsed.data.startsAt) <= now && now < Date.parse(parsed.data.expiresAt) ? parsed.data : null;
}

/** Provider-reported holds retain the existing 24-hour health limit. */
export const PROVIDER_DELETION_WAITING_STAGES = ["waiting_for_uploads", "kept_for_newer_snapshots", "waiting_for_restore"];

/** The health alert and the exception inventory share the exact predicates.
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

/** Read-only and target-bound. A missing receipt, current generation, foreign
 * binding, failed intent or additional stalled resource keeps readiness closed.
 * Neither provider completion nor erasure/accounting state is fabricated. */
export async function canDeferRetiredBoatDeletions(tx: Tx, sandboxIds: readonly string[]): Promise<boolean> {
  if (sandboxIds.length === 0 || sandboxIds.length > 7 || new Set(sandboxIds).size !== sandboxIds.length ||
    sandboxIds.some(id => !/^bx_[a-z0-9]+$/.test(id))) return false;
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
        AND operation.provider='boat' AND operation.resource_id=ANY($2::text[])
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
  ) AS eligible`, [PROVIDER_DELETION_WAITING_STAGES, sandboxIds]);
  return result.rows[0]?.eligible === true;
}
