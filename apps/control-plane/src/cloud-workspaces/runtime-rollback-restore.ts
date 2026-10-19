import type { Tx } from "../db.js";
import { parseRuntimeRollbackOffer, type RuntimeRollbackRestore } from "./runtime-rollback-contract.js";
import { RuntimeDescriptorSchema } from "./runtime-contract.js";

export class RuntimeRollbackProofError extends Error {
  constructor() { super("Runtime rollback proof is invalid"); }
}

export async function runtimeRollbackCacheSupported(tx: Tx, baseCompatibilityId: string): Promise<boolean> {
  return !!(await tx.query(`SELECT 1 FROM cloud_runtime_base_contracts
    WHERE base_compatibility_id=$1 AND contract->'runtimeRollbackCacheVersion'='1'::jsonb AND revoked_at IS NULL`, [baseCompatibilityId])).rowCount;
}

/** The capability check precedes new-table access so old bases and previous
 * schema fixtures retain their old reader/writer behavior. */
export async function readRuntimeRollbackRestore(tx: Tx, scope: { workspaceId: string; organizationId: string; transitionId: string },
  baseCompatibilityId: string): Promise<RuntimeRollbackRestore | null> {
  if (!await runtimeRollbackCacheSupported(tx, baseCompatibilityId)) return null;
  const row = (await tx.query<{ retention_id: string; deadline_at: Date; proof: unknown; target_descriptor: unknown; provider_resource_id: string }>(`SELECT restore.retention_id,restore.deadline_at,reference.proof,
      runtime.target_descriptor,runtime.provider_resource_id
    FROM cloud_workspace_runtime_rollback_restores restore JOIN cloud_workspace_runtime_rollback_refs reference ON reference.id=restore.retention_id
      AND reference.workspace_id=restore.workspace_id AND reference.org_id=restore.org_id
    JOIN cloud_workspace_runtime_transitions runtime ON runtime.transition_id=restore.transition_id
      AND runtime.workspace_id=restore.workspace_id AND runtime.org_id=restore.org_id
    WHERE restore.transition_id=$1 AND restore.workspace_id=$2 AND restore.org_id=$3`,
  [scope.transitionId,scope.workspaceId,scope.organizationId])).rows[0];
  if (!row) return null;
  try {
    const proof = parseRuntimeRollbackOffer(row.proof), target = RuntimeDescriptorSchema.parse(row.target_descriptor);
    if (proof.baseCompatibilityId !== baseCompatibilityId || proof.scope.workspaceId !== scope.workspaceId ||
      proof.scope.organizationId !== scope.organizationId || proof.scope.providerResourceId !== row.provider_resource_id ||
      Object.entries(target).some(([key,value]) => proof.runtime[key as keyof typeof target] !== value)) throw new RuntimeRollbackProofError();
    return { retentionId: row.retention_id, deadline: row.deadline_at.toISOString(), installerReceiptSha256: proof.installerReceiptSha256 };
  } catch { throw new RuntimeRollbackProofError(); }
}
