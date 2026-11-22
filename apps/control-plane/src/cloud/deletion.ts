import type { Tx } from "../db.js";

/** Retain resource rows until the provider has confirmed deletion. */
export async function scheduleCloudDeletion(
  tx: Tx,
  scope: { organizationId: string } | { userId: string },
): Promise<void> {
  const organizationId = "organizationId" in scope ? scope.organizationId : null;
  const userId = "userId" in scope ? scope.userId : null;
  if (userId) await tx.query("SELECT clear_cloud_creator_ownership(NULL,$1,'account_revoked')", [userId]);
  if (userId) {
    // Retention S4: the account's personal projects go at once, in every organization: their copies retired
    // (machines deleted by the copy builder's cleanup), then the projects, which removes their build secrets and
    // repositories. Copies before projects, in id order (CloudV2ReadyCopies lock order). And its personal GitHub
    // connections: the account's users row is anonymized, never deleted, so no cascade reaches them.
    await tx.query(`UPDATE cloud_v2_ready_copies SET state=CASE WHEN state='building' THEN 'failed' ELSE 'retired' END,
      failure_reason=CASE WHEN state='building' THEN 'project_removed' ELSE failure_reason END, updated_at=clock_timestamp()
      WHERE id IN (SELECT c.id FROM cloud_v2_ready_copies c JOIN cloud_projects p ON p.id=c.project_id
        WHERE p.level='personal' AND p.owner_user_id=$1 AND c.state IN ('building','ready') ORDER BY c.id FOR UPDATE OF c)`, [userId]);
    await tx.query(`UPDATE cloud_v2_workspaces SET project_id=NULL WHERE project_id IN
      (SELECT id FROM cloud_projects WHERE level='personal' AND owner_user_id=$1)`, [userId]);
    await tx.query("DELETE FROM cloud_projects WHERE level='personal' AND owner_user_id=$1", [userId]);
    await tx.query("DELETE FROM cloud_github_installations WHERE level='personal' AND owner_user_id=$1", [userId]);
  }
  if (organizationId) {
    // Ready copies are provider receipts: retired here, their machines deleted by the copy builder's
    // cleanup. Locked before the builds, in id order (CloudV2ReadyCopies lock order).
    await tx.query(`UPDATE cloud_v2_ready_copies SET state=CASE WHEN state='building' THEN 'failed' ELSE 'retired' END,
      failure_reason=CASE WHEN state='building' THEN 'organization_deleted' ELSE failure_reason END, updated_at=clock_timestamp()
      WHERE id IN (SELECT id FROM cloud_v2_ready_copies WHERE org_id=$1 AND state IN ('building','ready') ORDER BY id FOR UPDATE)`, [organizationId]);
    // Build secrets are only ever read by a ready copy build.
    await tx.query("DELETE FROM cloud_v2_ready_copy_secrets WHERE org_id=$1", [organizationId]);
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
     WHERE ($1::uuid IS NULL OR org_id=$1) AND ($2::uuid IS NULL OR creator_user_id=$2
         -- A personal project's workspace is its member's alone: under team ownership its creator was just cleared,
         -- and nobody could ever reach it again. It goes with the account (retention S4).
         OR private_owner_user_id=$2)
       AND state NOT IN ('deleting','deleted')`,
    [organizationId, userId],
  );
  await tx.query(
    `DELETE FROM cloud_v2_tokens WHERE workspace_id IN
       (SELECT id FROM cloud_v2_workspaces WHERE ($1::uuid IS NULL OR org_id=$1)
         AND ($2::uuid IS NULL OR creator_user_id=$2 OR private_owner_user_id=$2))`,
    [organizationId, userId],
  );
}
