import type { Tx } from "../db.js";

/** Retain resource rows until the provider has confirmed deletion. */
export async function scheduleCloudDeletion(
  tx: Tx,
  scope: { organizationId: string } | { userId: string },
): Promise<void> {
  const organizationId = "organizationId" in scope ? scope.organizationId : null;
  const userId = "userId" in scope ? scope.userId : null;
  if (organizationId) {
    // Build completion is conditional on state/cleanup_requested_at. A provider
    // reply already in flight keeps its durable intent and is cleaned up later.
    await tx.query(`UPDATE cloud_v2_computer_builds
      SET cleanup_requested_at=coalesce(cleanup_requested_at,clock_timestamp()),
          state=CASE WHEN state IN ('queued','building') THEN 'cancelled' ELSE state END
      WHERE org_id=$1`, [organizationId]);
    await tx.query(`UPDATE cloud_v2_computers SET active_build_id=NULL,snapshot_name=NULL WHERE org_id=$1`, [organizationId]);
  }
  await tx.query(
    `UPDATE cloud_v2_workspaces SET state='deleting', worker_token_hash=NULL,
       attempts=0, next_attempt_at=NULL, error_code=NULL, updated_at=clock_timestamp()
     WHERE ($1::uuid IS NULL OR org_id=$1) AND ($2::uuid IS NULL OR creator_user_id=$2)
       AND state NOT IN ('deleting','deleted')`,
    [organizationId, userId],
  );
  await tx.query(
    `DELETE FROM cloud_v2_tokens WHERE workspace_id IN
       (SELECT id FROM cloud_v2_workspaces WHERE ($1::uuid IS NULL OR org_id=$1)
         AND ($2::uuid IS NULL OR creator_user_id=$2))`,
    [organizationId, userId],
  );
}
