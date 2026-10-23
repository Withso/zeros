// Alias `w` is the workspace row. Keep HTTP, proxy and durable worker authority
// identical; a device session is checked only when admitting new app work.
export const CLOUD_V2_LIVE_ACCESS = `EXISTS (
  SELECT 1 FROM organization_members m
  JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL
  JOIN users u ON u.id = m.user_id AND u.auth_status = 'active' AND u.deleted_at IS NULL
  WHERE m.org_id = w.org_id AND m.user_id = w.creator_user_id
    AND NOT o.is_personal AND o.cloud_workspaces_allowed)`;
