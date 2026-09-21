-- Capabilities bind the exact actor authority, including guest grant identity.
-- Historical null bindings are accepted only for legacy private owner access.
ALTER TABLE workspace_replica_grants ADD COLUMN actor_fingerprint text CHECK (actor_fingerprint ~ '^[a-f0-9]{64}$');
ALTER TABLE workspace_export_grants ADD COLUMN actor_fingerprint text CHECK (actor_fingerprint ~ '^[a-f0-9]{64}$');
ALTER TABLE cloud_workspace_endpoint_grants ADD COLUMN actor_fingerprint text CHECK (actor_fingerprint ~ '^[a-f0-9]{64}$');
ALTER TABLE cloud_workspace_client_access_grants ADD COLUMN actor_fingerprint text CHECK (actor_fingerprint ~ '^[a-f0-9]{64}$');
ALTER TABLE cloud_workspace_runtime_service_grants ADD COLUMN actor_fingerprint text CHECK (actor_fingerprint ~ '^[a-f0-9]{64}$');

-- Existing human-service capabilities have no issue-time actor identity. They
-- are short-lived and can be reissued; never let NULL authorize a regranted
-- identity. Provider SSH revocation is durable and completed by its worker.
UPDATE cloud_workspace_client_access_grants SET state='revocation_pending',
  revocation_reason='actor_authority_required',next_revocation_at=now(),updated_at=now()
  WHERE state IN ('issuing','active');
UPDATE cloud_workspace_runtime_service_grants SET revoked_at=coalesce(revoked_at,now());

CREATE FUNCTION cloud_workspace_actor_fingerprint(target_workspace_id uuid,target_user_id uuid)
RETURNS text LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT encode(digest(jsonb_build_array(workspace.access_revision,workspace.owner_user_id,
    workspace.team_id,team_member.created_at,
    account.auth_revision,account.staff_role,organization.authorization_revision,
    membership.authorization_revision,membership.role,membership.created_at,
    explicit_member.role,explicit_member.updated_at,guest.id,guest.revision,guest.role,
    account_entitlement.revision,account_entitlement.updated_at,
    org_entitlement.revision,org_entitlement.updated_at,seat.revision,seat.assigned_at)::text,'sha256'),'hex')
  FROM cloud_workspaces workspace
  JOIN users account ON account.id=target_user_id
  JOIN organizations organization ON organization.id=workspace.org_id
  LEFT JOIN organization_members membership ON membership.org_id=workspace.org_id AND membership.user_id=account.id
  LEFT JOIN team_members team_member ON team_member.org_id=workspace.org_id AND team_member.team_id=workspace.team_id AND team_member.user_id=account.id
  LEFT JOIN cloud_workspace_members explicit_member ON explicit_member.workspace_id=workspace.id AND explicit_member.user_id=account.id
  LEFT JOIN cloud_workspace_guest_grants guest ON guest.workspace_id=workspace.id AND guest.user_id=account.id AND guest.revoked_at IS NULL
  LEFT JOIN account_entitlements account_entitlement ON account_entitlement.user_id=account.id
  LEFT JOIN organization_entitlements org_entitlement ON org_entitlement.org_id=workspace.org_id
  LEFT JOIN organization_seat_assignments seat ON seat.org_id=workspace.org_id AND seat.user_id=account.id
  WHERE workspace.id=target_workspace_id AND app_is_system()
$$;
REVOKE ALL ON FUNCTION cloud_workspace_actor_fingerprint(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_actor_fingerprint(uuid,uuid) TO zeros_app;

-- Row revocation also fences legacy private-owner grants without a fingerprint,
-- including removal/recreation in one transaction (where now() is unchanged).
-- Do not lock the workspace here: membership drains share the child-table order
-- and can run after the deleting user's organization RLS access disappeared.
CREATE FUNCTION revoke_cloud_workspace_data_for_membership()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE removed_team_id uuid;
BEGIN
  IF TG_TABLE_NAME='team_members' THEN removed_team_id:=OLD.team_id; END IF;
  UPDATE workspace_replica_grants grant_row SET revoked_at=now()
  FROM cloud_workspaces workspace
  WHERE grant_row.workspace_id=workspace.id AND grant_row.org_id=workspace.org_id
    AND grant_row.org_id=OLD.org_id AND grant_row.user_id=OLD.user_id
    AND (removed_team_id IS NULL OR workspace.team_id=removed_team_id)
    AND grant_row.revoked_at IS NULL;
  UPDATE workspace_export_grants grant_row SET revoked_at=now()
  FROM cloud_workspaces workspace
  WHERE grant_row.workspace_id=workspace.id AND grant_row.org_id=workspace.org_id
    AND grant_row.org_id=OLD.org_id AND grant_row.user_id=OLD.user_id
    AND (removed_team_id IS NULL OR workspace.team_id=removed_team_id)
    AND grant_row.revoked_at IS NULL;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION revoke_cloud_workspace_data_for_membership() FROM PUBLIC;
CREATE TRIGGER cloud_workspace_data_org_membership_removed AFTER DELETE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION revoke_cloud_workspace_data_for_membership();
CREATE TRIGGER cloud_workspace_data_team_membership_removed AFTER DELETE ON team_members
  FOR EACH ROW EXECUTE FUNCTION revoke_cloud_workspace_data_for_membership();
