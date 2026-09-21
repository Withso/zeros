import type {Tx} from "../db.js";

/** After tenant/workspace authority and before blob row/reference locks.
 * Reference triggers use this same key; acquiring it explicitly avoids an
 * advisory/row inversion when content is deduplicated across workspaces. */
export async function lockWorkspaceObjectStorage(tx: Tx, organizationId: string): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(
    hashtextextended('workspace-object-storage:' || $1::uuid::text, 0)
  )`, [organizationId]);
}
