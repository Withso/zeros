import { audit } from "../audit.js";
import type { Tx } from "../db.js";
import { enqueueWorkspaceCheckpointRequest } from "./checkpoint-requests.js";

type StopScope = { workspaceId: string; organizationId: string; generation: number; intentId: string };

/** Caller holds the workspace row lock. Absence of a request is not seal
 * proof: system/legacy stops may have bypassed checkpoint admission. A live
 * writer gets the normal gate; closed authority cannot be resurrected to seal. */
export async function prepareCloudWorkspaceStopSeal(
  tx: Tx,
  input: StopScope & { operation: "stop" | "archive" | "delete"; requestedBy?: string | null },
): Promise<boolean> {
  const request = (await tx.query<{ id: string; state: string; error_code: string | null }>(
    `SELECT id,state,error_code FROM workspace_checkpoint_requests
     WHERE lifecycle_intent_id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4`,
    [input.intentId, input.workspaceId, input.organizationId, input.generation],
  )).rows[0];
  if (request && request.state !== "succeeded" && request.error_code !== "stop_unsealed") return false;
  const writer = (await tx.query<{ writer_epoch: string; sealed_sequence: string | null; can_seal: boolean }>(
    `SELECT writer.writer_epoch,writer.sealed_sequence,
       (workspace.current_generation=$3 AND workspace.desired_state='running'
        AND workspace.status IN ('setting_up','ready','busy')
        AND engine.state='ready' AND engine.revoked_at IS NULL AND engine.final_checkpoint_at IS NULL
        AND engine.lease_expires_at>clock_timestamp()
        AND cloud_workspace_compute_authority_live(workspace.id,$3)) AS can_seal
     FROM cloud_workspace_local_command_writers writer
     JOIN cloud_workspaces workspace ON workspace.id=writer.workspace_id AND workspace.org_id=writer.org_id
     JOIN cloud_workspace_engine_instances engine ON engine.id=writer.engine_instance_id
       AND engine.workspace_id=writer.workspace_id AND engine.org_id=writer.org_id AND engine.generation=writer.generation
     WHERE writer.workspace_id=$1 AND writer.org_id=$2 AND writer.generation=$3 AND writer.activated_at IS NOT NULL
     ORDER BY writer.activated_at DESC,writer.writer_epoch DESC LIMIT 1`,
    [input.workspaceId, input.organizationId, input.generation],
  )).rows[0];
  // Legacy engines still use the checkpoint gate above. An allocation which
  // never activated a native writer has no native seal to wait for.
  if (!writer || writer.sealed_sequence !== null) return true;
  if (!request && writer.can_seal) {
    await enqueueWorkspaceCheckpointRequest(tx, {
      ...input, lifecycleIntentId: input.intentId, requestedBy: input.requestedBy ?? null,
      reason: input.operation === "stop" ? "before_stop" : input.operation === "archive" ? "before_archive" : "before_delete",
      idempotencyKey: `stop-seal.${input.intentId}`,
    });
    return false;
  }
  await recordCloudWorkspaceStopUnsealed(tx, {
    ...input, checkpointRequestId: request?.id ?? null,
    reason: request?.error_code === "stop_unsealed" ? "seal_deadline" : "authority_closed",
  });
  return true;
}

/** The workspace lock serializes this receipt with checkpoint completion and
 * other stop workers. It records loss of the final seal, never a fabricated
 * checkpoint or proof that the provider has actually stopped. */
export async function recordCloudWorkspaceStopUnsealed(
  tx: Tx,
  input: StopScope & {
    reason: "seal_deadline" | "authority_closed";
    checkpointRequestId: string | null;
  },
): Promise<void> {
  if ((await tx.query(`SELECT 1 FROM audit_log WHERE org_id=$1
    AND action='cloud_workspace.stop_unsealed' AND subject->>'intentId'=$2`,
  [input.organizationId, input.intentId])).rowCount) return;
  const writer = (await tx.query<{ writer_epoch: string }>(`SELECT writer_epoch FROM cloud_workspace_local_command_writers
    WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND activated_at IS NOT NULL
    ORDER BY activated_at DESC,writer_epoch DESC LIMIT 1`, [input.workspaceId, input.organizationId, input.generation])).rows[0];
  await audit(tx, input.organizationId, null, "cloud_workspace.stop_unsealed", {
    workspaceId: input.workspaceId, generation: input.generation, intentId: input.intentId,
    outcome: "stop_unsealed", reason: input.reason, checkpointRequestId: input.checkpointRequestId,
    writerEpoch: writer?.writer_epoch ?? null,
  });
}
