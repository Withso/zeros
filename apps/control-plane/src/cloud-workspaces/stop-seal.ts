import type { Tx } from "../db.js";
import { enqueueWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import { ensureFinalSaveRecovery, finalSaveProven, scheduleFinalSaveRecovery } from "./final-save-recovery.js";

type StopScope = { workspaceId: string; organizationId: string; generation: number; intentId: string };

/** Caller holds the workspace row lock. Absence of a request is not seal
 * proof: system/legacy stops may have bypassed checkpoint admission. A live
 * writer gets the normal gate; closed authority cannot be resurrected to seal. */
export async function prepareCloudWorkspaceStopSeal(
  tx: Tx,
  input: StopScope & { operation: "stop" | "archive" | "delete"; requestedBy?: string | null },
): Promise<boolean> {
  await ensureFinalSaveRecovery(tx, input.intentId);
  if (await finalSaveProven(tx, input.intentId)) return true;
  const request = (await tx.query<{ id: string; state: string; error_code: string | null }>(
    `SELECT id,state,error_code FROM workspace_checkpoint_requests
     WHERE lifecycle_intent_id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4`,
    [input.intentId, input.workspaceId, input.organizationId, input.generation],
  )).rows[0];
  if (!request) {
    await enqueueWorkspaceCheckpointRequest(tx, {
      ...input, lifecycleIntentId: input.intentId, requestedBy: input.requestedBy ?? null,
      reason: input.operation === "stop" ? "before_stop" : input.operation === "archive" ? "before_archive" : "before_delete",
      idempotencyKey: `stop-seal.${input.intentId}`,
    });
  }
  if (request && ["failed", "expired", "cancelled"].includes(request.state))
    await scheduleFinalSaveRecovery(tx, { intentId: input.intentId, requestId: request.id, failure: "legacy_cancelled", blocked: true });
  return false;
}
