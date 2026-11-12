import { createHash } from "node:crypto";
import type { Tx } from "../../db.js";
import { HttpError } from "../../authz.js";
import { memberOnHoldSql } from "../../organization-seats.js";
import { teamConnectionRevisionSql } from "../team-sharing/authority.js";
import { CLOUD_V2_LIVE_ACCESS } from "../workspace-access.js";

export type PreparedExecutionSnapshot = { workspaceId: string; organizationId: string; creatorUserId: string;
  initiatorUserId: string; state: string; accessEpoch: string; stopGeneration: string; sandboxId: string | null; bootId: string | null;
  sourceRevision: string; initiatorAccountRevision: string; initiatorMemberRevision: string; initiatorMemberCreatedAt: string;
  organizationRevision: string; initiatorConnectionRevision: string };
export const executionActivationDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");

export async function preparedExecutionSnapshot(tx: Tx, id: string, initiator: string): Promise<PreparedExecutionSnapshot> {
  const row = (await tx.query(`SELECT w.id,w.org_id,w.creator_user_id,w.state,w.access_epoch::text,w.stop_generation::text,
    w.boat_sandbox_id,w.worker_boot_id,w.repository,w.branch,w.base_branch,w.computer_build_id,w.source_pending,w.source_repositories,
    u.auth_revision::text AS account_revision,m.authorization_revision::text AS member_revision,m.created_at::text AS member_created_at,
    o.authorization_revision::text AS organization_revision,${teamConnectionRevisionSql("w.org_id", "$2")} AS connection_revision,
    coalesce((SELECT jsonb_agg(jsonb_build_array(s.source_repository,s.repository_id::text) ORDER BY s.source_repository)
      FROM cloud_v2_github_sources s WHERE s.workspace_id=w.id),'[]'::jsonb) AS sources
    FROM cloud_v2_workspaces w JOIN organizations o ON o.id=w.org_id
    JOIN organization_members m ON m.org_id=w.org_id AND m.user_id=$2 JOIN users u ON u.id=m.user_id
    WHERE w.id=$1 AND w.archived_at IS NULL AND w.state NOT IN ('creating','deleting','deleted','failed')
      AND NOT w.source_pending AND ${CLOUD_V2_LIVE_ACCESS}
      AND u.auth_status='active' AND u.deleted_at IS NULL AND NOT ${memberOnHoldSql("m.org_id", "m.user_id")}`, [id, initiator])).rows[0];
  if (!row) throw new HttpError(403, "member_access_revoked", "Execution plan requires a live workspace and initiator");
  return { workspaceId: row.id, organizationId: row.org_id, creatorUserId: row.creator_user_id, initiatorUserId: initiator,
    state: row.state, accessEpoch: row.access_epoch, stopGeneration: row.stop_generation, sandboxId: row.boat_sandbox_id, bootId: row.worker_boot_id,
    sourceRevision: executionActivationDigest([row.repository,row.branch,row.base_branch,row.computer_build_id,row.source_repositories,row.sources]),
    initiatorAccountRevision: row.account_revision, initiatorMemberRevision: row.member_revision, initiatorMemberCreatedAt: row.member_created_at,
    organizationRevision: row.organization_revision, initiatorConnectionRevision: executionActivationDigest(row.connection_revision) };
}
