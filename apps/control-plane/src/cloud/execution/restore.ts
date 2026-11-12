import type pg from "pg";
import { withSystemTx } from "../../db.js";
import type { CloudV2LifecycleWorkspace } from "../store.js";

/** A lost command reply cannot prove the VM still contains only its snapshot.
 * Consume the attempt before releasing a credential; only a new VM resets it. */
export async function claimExecutionRestore(pool: pg.Pool, workspace: CloudV2LifecycleWorkspace, sandboxId: string): Promise<boolean> {
  const intent = workspace.executionIntent, checkpoint = workspace.checkpoint;
  if (!intent?.id || !intent.userId || !checkpoint) return false;
  const result = await withSystemTx(pool, tx => tx.query(`UPDATE cloud_v2_workspaces w SET execution_restore_claimed_at=clock_timestamp()
    WHERE id=$1 AND state='starting' AND archived_at IS NULL AND execution_mode='active' AND execution_transition_id IS NULL
      AND boat_sandbox_id=$2 AND restore_pending AND restore_attempt IS NOT NULL AND execution_restore_claimed_at IS NULL
      AND checkpoint_object=$3 AND execution_intent_id=$4 AND execution_initiator_user_id=$5 AND access_epoch=$6 AND stop_generation=$7
      AND EXISTS(SELECT 1 FROM cloud_v2_computer_builds b WHERE b.id=w.computer_build_id AND b.org_id=w.org_id
        AND b.source_policy_version IN (2,3) AND b.state='succeeded' AND b.snapshot_id=w.restore_create->>'from')`,
  [workspace.id, sandboxId, checkpoint.object, intent.id, intent.userId, intent.accessEpoch, workspace.stopGeneration]));
  return result.rowCount === 1;
}
