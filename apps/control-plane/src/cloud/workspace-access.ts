import { PRO_ORGANIZATION_MEMBER_LIMIT, PRO_ORGANIZATION_FREE_MEMBER_LIMIT } from "../organization-seats.js";
import { sql, SqlFragment } from "../sql-fragment.js";

const LIVE_CREATOR = sql`SELECT 1 FROM organization_members m
  JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL
  JOIN users u ON u.id = m.user_id AND u.auth_status = 'active' AND u.deleted_at IS NULL
  WHERE m.org_id = w.org_id AND m.user_id = w.creator_user_id
    AND NOT o.is_personal AND o.cloud_workspaces_allowed`;
const ON_HOLD = sql`organization_member_on_hold(m.org_id, m.user_id,
  ${SqlFragment.integer(PRO_ORGANIZATION_MEMBER_LIMIT, 1, Number.MAX_SAFE_INTEGER)},
  ${SqlFragment.integer(PRO_ORGANIZATION_FREE_MEMBER_LIMIT, 0, Number.MAX_SAFE_INTEGER)})`;

// Alias `w` is the workspace row. Keep HTTP, proxy and durable worker authority
// identical; a device session is checked only when admitting new app work. A
// creator on Hold keeps the membership but loses the workspace on every path.
export const CLOUD_V2_LIVE_ACCESS_SQL = sql`EXISTS (
  ${LIVE_CREATOR}
    AND NOT ${ON_HOLD})`;
export const CLOUD_V2_LIVE_ACCESS = CLOUD_V2_LIVE_ACCESS_SQL.text;

/** Live access fails only because the creator is on Hold. */
export const CLOUD_V2_CREATOR_ON_HOLD = sql`EXISTS (
  ${LIVE_CREATOR}
    AND ${ON_HOLD})`.text;
