import { HttpError } from "../../authz.js";
import type { Tx } from "../../db.js";
import type { CloudV2BootCleanRefusal } from "../contract.js";

export const activationBusy = () => new HttpError(409, "actor_busy", "Shared execution is changing; wait for the workspace to restart");

export async function assertNoExecutionTransition(tx: Tx, id: string) {
  if ((await tx.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND execution_transition_id IS NOT NULL", [id])).rowCount)
    throw activationBusy();
}

/** Stop cancels even an already-stopping rollout. Only its provider-confirmed
 * completion may remove the protocol fence or release the old process barrier. */
export async function cancelExecutionActivation(tx: Tx, id: string) {
  await tx.query(`UPDATE cloud_v2_execution_activations a SET phase='cancelled',
    first_error_code=coalesce(first_error_code,'activation_cancelled'),updated_at=clock_timestamp()
    FROM cloud_v2_workspaces w WHERE w.id=$1 AND a.id=w.execution_transition_id
      AND a.phase IN ('draining','authorizing','booting')`, [id]);
}

export async function clearStoppedExecutionTransition(tx: Tx, id: string) {
  await tx.query(`UPDATE cloud_v2_workspaces w SET execution_transition_id=NULL,execution_mode='prepared',
    execution_intent_id=NULL,execution_initiator_user_id=NULL,execution_intent_authority=NULL
    FROM cloud_v2_execution_activations a WHERE w.id=$1 AND a.id=w.execution_transition_id
      AND a.phase IN ('failed','cancelled') AND a.confirmed_stop_generation=w.stop_generation
      AND a.confirmed_stopped_at IS NOT NULL AND w.state='stopped' AND w.worker_token_hash IS NULL`, [id]);
  await tx.query(`UPDATE cloud_v2_execution_activations a SET completed_at=coalesce(completed_at,clock_timestamp()),updated_at=clock_timestamp()
    FROM cloud_v2_workspaces w WHERE w.id=$1 AND a.workspace_id=w.id AND a.phase IN ('failed','cancelled')
      AND a.confirmed_stop_generation=w.stop_generation AND a.confirmed_stopped_at IS NOT NULL
      AND w.state='stopped' AND w.execution_transition_id IS NULL`, [id]);
}

export async function confirmExecutionStop(tx: Tx, id: string, generation: string) {
  await tx.query(`UPDATE cloud_v2_execution_activations a SET confirmed_stop_generation=$2,confirmed_stopped_at=clock_timestamp(),
    drained_at=CASE WHEN a.phase='draining' AND a.stop_generation=$2 THEN clock_timestamp() ELSE a.drained_at END,
    phase=CASE WHEN a.phase='draining' AND a.stop_generation=$2 THEN 'authorizing' ELSE a.phase END,
    next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
    FROM cloud_v2_workspaces w WHERE w.id=$1 AND a.workspace_id=w.id
      AND (a.id=w.execution_transition_id OR a.phase='active')`, [id, generation]);
  await clearStoppedExecutionTransition(tx, id);
}

export async function failExecutionActivation(tx: Tx, id: string, code: string,
  bootClean?: { legacyMaterial: "none" | "removed" | "refused"; refusals: CloudV2BootCleanRefusal[] | null }) {
  const result = await tx.query(`UPDATE cloud_v2_execution_activations a SET phase='failed',first_error_code=coalesce(first_error_code,$2),
    legacy_material=CASE WHEN first_error_code IS NULL AND $3::text IS NOT NULL THEN $3 ELSE legacy_material END,
    first_failed_refusals=CASE WHEN first_error_code IS NULL THEN $4::text[] ELSE first_failed_refusals END,updated_at=clock_timestamp()
    FROM cloud_v2_workspaces w WHERE w.id=$1 AND a.id=w.execution_transition_id AND a.phase IN ('draining','authorizing','booting')
    RETURNING a.id`, [id, code, bootClean?.legacyMaterial ?? null, bootClean?.refusals ?? null]);
  if (!result.rowCount) return;
  await clearStoppedExecutionTransition(tx, id);
  await tx.query(`UPDATE cloud_v2_workspaces SET state='stopping',stop_generation=stop_generation+CASE WHEN state='stopping' THEN 0 ELSE 1 END,
    access_epoch=access_epoch+1,restart_stop_generation=NULL,error_code=$2,attempts=0,next_attempt_at=NULL,updated_at=clock_timestamp()
    WHERE id=$1 AND execution_transition_id IS NOT NULL AND state NOT IN ('deleting','deleted')`, [id, code]);
}
