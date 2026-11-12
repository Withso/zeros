import { PRO_ORGANIZATION_MEMBER_LIMIT, PRO_ORGANIZATION_FREE_MEMBER_LIMIT, memberOnHoldSql } from "../organization-seats.js";
import { sql, SqlFragment } from "../sql-fragment.js";
import { HttpError } from "../authz.js";

/** Legacy credential paths require a Creator; active paths supply an actor. */
export function requireWorkspaceCreator<T extends { creatorUserId: string | null }>(workspace: T): asserts workspace is T & { creatorUserId: string } {
  if (!workspace.creatorUserId) throw new HttpError(409, "workspace_creator_required", "This workspace has no Creator");
}

const LIVE_CREATOR = sql`SELECT 1 FROM organization_members m
  JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL
  JOIN users u ON u.id = m.user_id AND u.auth_status = 'active' AND u.deleted_at IS NULL
  WHERE m.org_id = w.org_id AND m.user_id = w.creator_user_id
    AND NOT o.is_personal AND o.cloud_workspaces_allowed`;
const ON_HOLD = sql`organization_member_on_hold(m.org_id, m.user_id,
  ${SqlFragment.integer(PRO_ORGANIZATION_MEMBER_LIMIT, 1, Number.MAX_SAFE_INTEGER)},
  ${SqlFragment.integer(PRO_ORGANIZATION_FREE_MEMBER_LIMIT, 0, Number.MAX_SAFE_INTEGER)})`;

export const CLOUD_V2_CREATOR_ACCESS_SQL = sql`EXISTS (
  ${LIVE_CREATOR}
    AND NOT ${ON_HOLD})`;

// An active VM belongs to the organization. Personal admission is separate:
// one person's departure must not invalidate another person's running turn.
export const CLOUD_V2_LIVE_ACCESS_SQL = sql`(
  (w.execution_mode='active' AND EXISTS (SELECT 1 FROM organizations o
    WHERE o.id=w.org_id AND o.deleted_at IS NULL AND NOT o.is_personal AND o.cloud_workspaces_allowed))
  OR (w.execution_mode<>'active' AND ${CLOUD_V2_CREATOR_ACCESS_SQL}))`;
export const CLOUD_V2_LIVE_ACCESS = CLOUD_V2_LIVE_ACCESS_SQL.text;

/** Only the membership part of execution authority; callers must also prove
 * that person's immutable repository scope before releasing data or effects. */
export function cloudV2ActorAccess(parameter: "$1" | "$2" | "$3") {
  return `(w.execution_mode<>'active' AND w.creator_user_id=${parameter} OR w.execution_mode='active' AND EXISTS (
    SELECT 1 FROM organization_members am JOIN users au ON au.id=am.user_id
    WHERE am.org_id=w.org_id AND am.user_id=${parameter} AND au.auth_status='active' AND au.deleted_at IS NULL
      AND NOT ${memberOnHoldSql("am.org_id", "am.user_id")}))`;
}

/** Live access fails only because the creator is on Hold. */
export const CLOUD_V2_CREATOR_ON_HOLD = sql`EXISTS (
  ${LIVE_CREATOR}
    AND ${ON_HOLD})`.text;
