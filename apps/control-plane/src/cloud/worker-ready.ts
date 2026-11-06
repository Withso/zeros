import type { Tx } from "../db.js";

/** Wakes relay rooms waiting for a workspace's worker. Only a hint: it is
 * delivered on commit, carries no authority, and relay polling remains. */
export const CLOUD_V2_READY_CHANNEL = "zeros_cloud_v2_ready";

export async function notifyCloudV2WorkerReady(tx: Tx, workspaceId: string): Promise<void> {
  await tx.query("SELECT pg_notify($1, $2)", [CLOUD_V2_READY_CHANNEL, workspaceId]);
}
