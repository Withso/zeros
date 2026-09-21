-- zeros:requires-controlled-downtime
-- Pro funding belongs to an account, independently of organization membership.
-- Drain old workers before this authority change. Existing Pro billing epochs
-- remain immutable; the paid-authority reconciler binds the owner's current
-- account entitlement before execution can resume. Business seats are retained.

CREATE FUNCTION cloud_workspace_pilot_user_live(target_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM users account WHERE account.id = target_user_id
    AND account.auth_status = 'active' AND account.deleted_at IS NULL
    AND account.staff_role IN ('platform_owner', 'developer'))
$$;
REVOKE ALL ON FUNCTION cloud_workspace_pilot_user_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_pilot_user_live(uuid) TO zeros_app;

CREATE FUNCTION cloud_workspace_pro_user_live(target_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT cloud_workspace_pilot_user_live(target_user_id) AND EXISTS (
    SELECT 1 FROM account_entitlements entitlement
    WHERE entitlement.user_id = target_user_id AND entitlement.plan = 'pro'
      AND entitlement.status IN ('active', 'trialing')
      AND entitlement.cloud_workspaces_allowed AND entitlement.valid_from <= now()
      AND (entitlement.valid_until IS NULL OR entitlement.valid_until > now()))
$$;
REVOKE ALL ON FUNCTION cloud_workspace_pro_user_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_pro_user_live(uuid) TO zeros_app;

-- This predicate represents the sponsor, never an attached human collaborator.
CREATE OR REPLACE FUNCTION cloud_workspace_paid_authority_live(
  target_workspace_id uuid, target_user_id uuid, require_workos boolean
) RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT cloud_workspace_pilot_user_live(target_user_id) AND EXISTS (
    SELECT 1 FROM cloud_workspaces workspace
    JOIN organizations organization ON organization.id = workspace.org_id
      AND organization.deleted_at IS NULL AND NOT organization.is_personal
      AND organization.cloud_workspaces_allowed
    JOIN organization_members member ON member.org_id = workspace.org_id
      AND member.user_id = target_user_id
    JOIN teams team ON team.id = workspace.team_id AND team.org_id = workspace.org_id
      AND team.deleted_at IS NULL
    JOIN team_members team_member ON team_member.team_id = team.id
      AND team_member.org_id = workspace.org_id AND team_member.user_id = target_user_id
    JOIN cloud_workspace_members workspace_member ON workspace_member.workspace_id = workspace.id
      AND workspace_member.org_id = workspace.org_id
      AND workspace_member.user_id = target_user_id AND workspace_member.role = 'owner'
    JOIN workspace_billing_epochs billing ON billing.workspace_id = workspace.id
      AND billing.org_id = workspace.org_id AND billing.billing_epoch = workspace.current_billing_epoch
      AND billing.ended_at IS NULL AND billing.billing_owner_user_id = target_user_id
    LEFT JOIN organization_entitlements organization_entitlement ON organization_entitlement.org_id = workspace.org_id
    WHERE workspace.id = target_workspace_id AND workspace.deleted_at IS NULL
      AND workspace.owner_user_id = target_user_id
      AND (NOT require_workos OR EXISTS (
        SELECT 1 FROM workos_organization_links link WHERE link.organization_id = workspace.org_id
          AND link.state = 'active' AND link.workos_organization_id IS NOT NULL))
      AND (
        ((organization_entitlement.plan IS NULL OR organization_entitlement.plan = 'pro')
          AND billing.entitlement_scope = 'account' AND billing.entitlement_plan = 'pro'
          AND cloud_workspace_pro_user_live(target_user_id)
          AND EXISTS (SELECT 1 FROM account_entitlements entitlement
            WHERE entitlement.user_id = target_user_id AND entitlement.revision = billing.entitlement_revision))
        OR (organization_entitlement.plan IN ('business', 'enterprise')
          AND billing.entitlement_scope = 'organization'
          AND billing.entitlement_plan = organization_entitlement.plan
          AND billing.entitlement_revision = organization_entitlement.revision
          AND organization_entitlement.status IN ('active', 'trialing')
          AND organization_entitlement.cloud_workspaces_allowed
          AND organization_entitlement.valid_from <= now()
          AND (organization_entitlement.valid_until IS NULL OR organization_entitlement.valid_until > now())
          AND EXISTS (SELECT 1 FROM organization_seat_assignments seat
            WHERE seat.org_id = workspace.org_id AND seat.user_id = target_user_id AND seat.state = 'active')
          AND (SELECT count(*) FROM organization_seat_assignments seat
            WHERE seat.org_id = workspace.org_id AND seat.state = 'active') <= organization_entitlement.seat_limit)
      )
  )
$$;

-- Staff revocation affects existing sessions immediately through live checks
-- and also wakes reconciliation to stop owner-funded resources promptly.
CREATE TRIGGER user_staff_cloud_authority_check
  AFTER UPDATE OF staff_role ON users FOR EACH ROW
  WHEN (OLD.staff_role IS DISTINCT FROM NEW.staff_role)
  EXECUTE FUNCTION enqueue_cloud_authority_for_user_auth_change();

INSERT INTO cloud_workspace_paid_authority_checks (workspace_id,org_id,next_check_at,reason)
  SELECT id,org_id,now(),'individual_pro_pilot_upgrade' FROM cloud_workspaces WHERE status <> 'deleted'
  ON CONFLICT (workspace_id) DO UPDATE SET next_check_at=now(),reason=EXCLUDED.reason,updated_at=now();
