import type { Tx } from "../db.js";

/** Existing loss attestations require complete inventory and exact not-found
 * evidence. This is a disposition of that source, not permission to stop a VM. */
export async function ownerDiscardedTransition(tx: Tx, input: {
  workspaceId: string; organizationId: string; transitionId: string; sourceGeneration: number;
}): Promise<string | null> {
  return (await tx.query<{ id:string }>(`SELECT receipt.id FROM cloud_workspace_owner_discard_receipts receipt
    WHERE receipt.transition_id=$1 AND receipt.workspace_id=$2 AND receipt.org_id=$3 AND receipt.source_generation=$4
      AND cloud_provider_allocation_lost(receipt.workspace_id,receipt.source_generation,receipt.org_id,receipt.provider_resource_id)`,
  [input.transitionId,input.workspaceId,input.organizationId,input.sourceGeneration])).rows[0]?.id ?? null;
}
