import type pg from "pg";
import { withSystemTx, type Tx } from "../../db.js";
import type { RuntimeCapabilities } from "../runtime-capabilities.js";
import type { CloudV2Runtime } from "../runtime.js";
import type { ExecutionWorkspace } from "./store.js";
import { actorChanged, executionWorkerRequired } from "./errors.js";

export async function recordExecutionCreation(tx: Tx, id: string, runtime: RuntimeCapabilities) {
  if (!runtime.features.includes("acting-user-v1") || !runtime.features.includes("sync-context-v1")) throw executionWorkerRequired();
  const result = await tx.query(`INSERT INTO cloud_v2_execution_creations
    (workspace_id,org_id,intent_id,runtime_sha256,source_sha256,source_sha)
    SELECT id,org_id,execution_intent_id,$2,$3,$4 FROM cloud_v2_workspaces
    WHERE id=$1 AND execution_mode='active' AND state='creating' AND NOT source_pending AND boat_sandbox_id IS NULL
      AND execution_initiator_user_id IS NOT NULL AND execution_intent_authority IS NOT NULL`,
  [id, runtime.sha256, runtime.sourceSha256, runtime.commit]);
  if (result.rowCount !== 1) throw actorChanged();
}

export async function executionCreationRuntime(pool: pg.Pool, id: string, current: CloudV2Runtime,
  qualify: () => Promise<RuntimeCapabilities>): Promise<CloudV2Runtime | null> {
  const row = (await withSystemTx(pool, tx => tx.query<{ runtime_sha256: string; pinned: boolean }>(`SELECT c.runtime_sha256,
    ((c.intent_id=w.execution_intent_id AND c.clean_at IS NULL) OR EXISTS (
      SELECT 1 FROM cloud_v2_runtime_canaries k WHERE k.workspace_id=w.id)) AS pinned
    FROM cloud_v2_execution_creations c JOIN cloud_v2_workspaces w ON w.id=c.workspace_id
    WHERE c.workspace_id=$1 AND w.execution_mode='active'`, [id]))).rows[0];
  if (!row) return null;
  if (row.pinned) return { sha256: row.runtime_sha256, url: () => current.url(row.runtime_sha256) };
  await qualify();
  return current;
}

export async function assertExecutionCreationBoot(tx: Tx, id: string, syncContext: boolean) {
  if (!syncContext && (await tx.query("SELECT 1 FROM cloud_v2_execution_creations WHERE workspace_id=$1", [id])).rowCount)
    throw executionWorkerRequired();
}

export async function failExecutionCreation(tx: Tx, workspace: ExecutionWorkspace) {
  const receipt = await tx.query(`UPDATE cloud_v2_execution_creations SET
    first_failed_boot_id=coalesce(first_failed_boot_id,$2),first_failed_at=coalesce(first_failed_at,clock_timestamp())
    WHERE workspace_id=$1 AND clean_at IS NULL RETURNING workspace_id`, [workspace.id, workspace.worker_boot_id]);
  if (!receipt.rowCount) return;
  await tx.query(`UPDATE cloud_v2_workspaces SET state='stopping',stop_generation=stop_generation+1,access_epoch=access_epoch+1,
    restart_stop_generation=NULL,error_code='execution_first_boot_failed',attempts=0,next_attempt_at=NULL,updated_at=clock_timestamp()
    WHERE id=$1 AND execution_mode='active' AND execution_transition_id IS NULL AND state IN ('creating','starting')
      AND worker_boot_id=$2 AND stop_generation=$3 AND access_epoch=$4`,
  [workspace.id, workspace.worker_boot_id, workspace.stop_generation, workspace.access_epoch]);
}

export async function completeExecutionCreation(tx: Tx, workspace: ExecutionWorkspace) {
  await tx.query(`UPDATE cloud_v2_execution_creations SET clean_boot_id=$2,clean_at=clock_timestamp()
    WHERE workspace_id=$1 AND clean_at IS NULL`, [workspace.id, workspace.worker_boot_id]);
  await tx.query(`UPDATE cloud_v2_workspaces SET error_code=NULL
    WHERE id=$1 AND error_code='execution_first_boot_failed' AND EXISTS (
      SELECT 1 FROM cloud_v2_execution_creations WHERE workspace_id=$1 AND clean_boot_id=$2)`, [workspace.id, workspace.worker_boot_id]);
}
