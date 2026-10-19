import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { CloudProviderError } from "./provider.js";

export type FinalSaveFailure = "capture_failed" | "commit_ambiguous" | "checkpoint_deadline_exceeded" |
  "legacy_cancelled" | "authority" | "custody" | "journal" | "scope" | "source_unavailable";
export const FINAL_SAVE_RETRY_FLOORS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;

/** Caller owns the parent/workspace locks. Existing accepted operations are
 * adopted without moving their unique original request link or source. */
export async function ensureFinalSaveRecovery(tx: Tx, intentId: string): Promise<void> {
  await tx.query("SELECT ensure_cloud_final_save_recovery($1)", [intentId]);
  await tx.query(`UPDATE cloud_workspace_final_save_recoveries recovery SET
    original_request_id=request.id,current_request_id=request.id,next_attempt_at=request.deadline_at
    FROM workspace_checkpoint_requests request WHERE recovery.lifecycle_intent_id=$1
      AND recovery.original_request_id IS NULL AND request.lifecycle_intent_id=recovery.lifecycle_intent_id
      AND request.workspace_id=recovery.workspace_id AND request.org_id=recovery.org_id AND request.generation=recovery.generation`, [intentId]);
  await tx.query(`UPDATE workspace_checkpoint_requests request SET final_save_recovery_id=recovery.lifecycle_intent_id,
    final_save_attempt_ordinal=0 FROM cloud_workspace_final_save_recoveries recovery
    WHERE recovery.lifecycle_intent_id=$1 AND recovery.original_request_id=request.id AND request.final_save_recovery_id IS NULL`, [intentId]);
  await tx.query("SELECT cloud_final_save_adopt_proof($1)", [intentId]);
}

/** Scheduling never extends capture or execution authority. DB-time floors
 * survive worker restart and lost notification. No provider I/O is owned here. */
export async function scheduleFinalSaveRecovery(tx: Tx, input: {
  intentId: string; requestId?: string; failure: FinalSaveFailure; blocked?: boolean;
}): Promise<void> {
  await tx.query(`UPDATE cloud_workspace_final_save_recoveries SET
    state=CASE WHEN $4 OR custody_id IS NULL THEN 'blocked' WHEN $3='commit_ambiguous' THEN 'reconciling' ELSE 'retrying' END,
    failure_started_at=coalesce(failure_started_at,clock_timestamp()),first_failure=coalesce(first_failure,$3),last_failure=$3,
    next_attempt_at=clock_timestamp()+(ARRAY[5,15,30,60,120,300])[least(retry_count,5)+1]*interval '1 second',
    retry_count=least(retry_count+1,1000000),updated_at=clock_timestamp()
    WHERE lifecycle_intent_id=$1 AND ($2::uuid IS NULL OR current_request_id=$2) AND state NOT IN ('proven','resolved')`,
  [input.intentId, input.requestId ?? null, input.failure, input.blocked ?? false]);
}

export async function finalSaveProven(tx: Tx, intentId: string): Promise<boolean> {
  return (await tx.query<{ proven: boolean }>("SELECT cloud_final_save_proven($1) AS proven", [intentId])).rows[0]?.proven === true;
}

/** Last database boundary after every preparatory provider/cache await. The
 * durable dispatch row continues to hold the allocation after this transaction
 * releases its locks, including a lost provider reply or expired worker lease. */
export async function requireFinalSaveDispatch(pool: pg.Pool, input: {
  workspaceId: string; organizationId: string; generation: number; intentId: string;
  providerResourceId: string; workerId: string; attemptCount: number; authorityEpoch: string | number;
}): Promise<void> {
  const allowed = await withSystemTx(pool, async tx => {
    await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [input.organizationId]);
    await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE", [input.workspaceId, input.organizationId]);
    return (await tx.query(`SELECT 1 FROM cloud_workspace_lifecycle_intents intent
      JOIN cloud_workspaces workspace ON workspace.id=intent.workspace_id AND workspace.org_id=intent.org_id
      JOIN cloud_workspace_final_save_dispatches dispatch ON dispatch.lifecycle_intent_id=intent.id
      WHERE intent.id=$1 AND intent.workspace_id=$2 AND intent.org_id=$3 AND intent.generation=$4
        AND intent.state='dispatching' AND intent.lease_owner=$5 AND intent.attempt_count=$6
        AND intent.lease_expires_at>clock_timestamp() AND workspace.authority_epoch=$7
        AND dispatch.provider_resource_id=$8 AND dispatch.settled_at IS NULL AND cloud_final_save_proven(intent.id)
      FOR UPDATE OF intent`, [input.intentId, input.workspaceId, input.organizationId, input.generation,
      input.workerId, input.attemptCount, input.authorityEpoch, input.providerResourceId])).rowCount === 1;
  });
  if (!allowed) throw new CloudProviderError("final_save_scope_changed", "Final save dispatch is no longer current", true);
}
