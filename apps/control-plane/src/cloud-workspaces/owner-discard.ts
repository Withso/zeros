import type { Tx } from "../db.js";

/** Existing loss attestations require complete inventory and exact not-found
 * evidence. This is a disposition of that source, not permission to stop a VM. */
export async function ownerDiscardedTransition(tx: Tx, input: {
  workspaceId: string; organizationId: string; transitionId: string; sourceGeneration: number;
}): Promise<string | null> {
  return (await tx.query<{ id:string|null }>(`SELECT cloud_owner_discard_transition_receipt($1,$2,$3,$4) AS id`,
  [input.transitionId,input.workspaceId,input.organizationId,input.sourceGeneration])).rows[0]?.id ?? null;
}
