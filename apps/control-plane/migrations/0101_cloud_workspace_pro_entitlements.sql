-- zeros:requires-controlled-downtime
SELECT set_config('app.system','on',true);
-- Individual Pro is the launch funding source. Historical organization billing
-- epochs remain distinct; this migration does not launch a Business product.
CREATE TABLE staff_pro_benefits (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 1000000000000)
);
CREATE TABLE staff_pro_benefit_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL,
  staff_role text,
  revision bigint NOT NULL,
  database_principal text NOT NULL DEFAULT session_user,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE staff_pro_benefits ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_pro_benefits FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_pro_benefits_read ON staff_pro_benefits FOR SELECT
  USING (app_is_system() OR user_id=app_current_user());
CREATE POLICY staff_pro_benefits_owner ON staff_pro_benefits FOR ALL
  USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.staff_pro_benefits'::regclass)))
  WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.staff_pro_benefits'::regclass)));
ALTER TABLE staff_pro_benefit_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_pro_benefit_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_pro_benefit_changes_owner ON staff_pro_benefit_changes FOR ALL
  USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.staff_pro_benefit_changes'::regclass)))
  WITH CHECK(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.staff_pro_benefit_changes'::regclass)));
REVOKE ALL ON staff_pro_benefits,staff_pro_benefit_changes FROM PUBLIC,zeros_app;
GRANT SELECT ON staff_pro_benefits TO zeros_app;

-- The existing owner-only staff operator is the sole write boundary. Benefits
-- have separate provenance so revoking staff never overwrites a paid plan.
CREATE FUNCTION sync_staff_pro_benefit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE benefit_revision bigint; enabled boolean;
BEGIN
  enabled:=coalesce(NEW.staff_role IN ('platform_owner','developer'),false);
  IF TG_OP='UPDATE' AND enabled=coalesce(OLD.staff_role IN ('platform_owner','developer'),false) THEN RETURN NEW; END IF;
  IF enabled THEN
    INSERT INTO staff_pro_benefits(user_id) VALUES(NEW.id)
      ON CONFLICT(user_id) DO UPDATE SET revoked_at=NULL,revision=staff_pro_benefits.revision+1
      RETURNING revision INTO benefit_revision;
  ELSE
    UPDATE staff_pro_benefits SET revoked_at=clock_timestamp(),revision=revision+1
      WHERE user_id=NEW.id AND revoked_at IS NULL RETURNING revision INTO benefit_revision;
  END IF;
  IF benefit_revision IS NOT NULL THEN
    INSERT INTO staff_pro_benefit_changes(user_id,enabled,staff_role,revision)
      VALUES(NEW.id,enabled,NEW.staff_role,benefit_revision);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sync_staff_pro_benefit() FROM PUBLIC;
CREATE TRIGGER staff_pro_benefit_sync AFTER INSERT OR UPDATE OF staff_role ON users
  FOR EACH ROW EXECUTE FUNCTION sync_staff_pro_benefit();
INSERT INTO staff_pro_benefits(user_id)
  SELECT id FROM users WHERE staff_role IN ('platform_owner','developer') AND deleted_at IS NULL;
INSERT INTO staff_pro_benefit_changes(user_id,enabled,staff_role,revision)
  SELECT benefit.user_id,true,account.staff_role,benefit.revision
  FROM staff_pro_benefits benefit JOIN users account ON account.id=benefit.user_id;

CREATE FUNCTION cloud_workspace_pro_entitlement(target_user_id uuid)
RETURNS TABLE(plan text,revision bigint,valid_from timestamptz,valid_until timestamptz,source text)
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT eligible.plan,eligible.revision,eligible.valid_from,eligible.valid_until,eligible.source
  FROM users account CROSS JOIN LATERAL (
    SELECT entitlement.plan,entitlement.revision,entitlement.valid_from,entitlement.valid_until,entitlement.source,0 AS priority
    FROM account_entitlements entitlement WHERE entitlement.user_id=account.id AND entitlement.plan='pro'
      AND (entitlement.status IN ('active','trialing') OR (entitlement.status='cancelled' AND entitlement.valid_until IS NOT NULL))
      AND entitlement.cloud_workspaces_allowed AND entitlement.valid_from<=clock_timestamp()
      AND (entitlement.valid_until IS NULL OR entitlement.valid_until>clock_timestamp())
    UNION ALL
    SELECT 'pro',900000000000000+benefit.revision,benefit.valid_from,NULL::timestamptz,'staff',1
    FROM staff_pro_benefits benefit WHERE benefit.user_id=account.id AND benefit.revoked_at IS NULL
      AND account.staff_role IN ('platform_owner','developer')
  ) eligible
  WHERE account.id=target_user_id AND account.auth_status='active' AND account.deleted_at IS NULL
    AND (app_is_system() OR account.id=app_current_user())
  ORDER BY eligible.priority LIMIT 1
$$;
REVOKE ALL ON FUNCTION cloud_workspace_pro_entitlement(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_pro_entitlement(uuid) TO zeros_app;
CREATE OR REPLACE FUNCTION cloud_workspace_pro_user_live(target_user_id uuid)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM cloud_workspace_pro_entitlement(target_user_id))
$$;

-- Extend the existing authenticated tombstone erasure boundary.
CREATE OR REPLACE FUNCTION purge_account_pro_configuration(p_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT public.app_is_system() THEN RAISE EXCEPTION 'system context required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.users WHERE id=p_user_id AND auth_status='deleted' AND deleted_at IS NOT NULL FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account purge state mismatch' USING ERRCODE='55000'; END IF;
  DELETE FROM public.staff_pro_benefit_changes WHERE user_id=p_user_id;
  DELETE FROM public.staff_pro_benefits WHERE user_id=p_user_id;
  DELETE FROM public.account_pro_entitlement_changes WHERE subject_user_id=p_user_id OR actor_user_id=p_user_id;
  DELETE FROM public.account_entitlements WHERE user_id=p_user_id;
END $$;

CREATE OR REPLACE FUNCTION public.cloud_workspace_paid_authority_live(target_workspace_id uuid, target_user_id uuid, require_workos boolean)
 RETURNS boolean
 LANGUAGE sql
 VOLATILE
 SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT EXISTS (
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
        (billing.entitlement_scope = 'account' AND billing.entitlement_plan = 'pro'
          AND cloud_workspace_pro_user_live(target_user_id)
          AND EXISTS (SELECT 1 FROM cloud_workspace_pro_entitlement(target_user_id) entitlement
            WHERE entitlement.revision = billing.entitlement_revision))
        OR (cloud_workspace_pilot_user_live(target_user_id)
          AND organization_entitlement.plan IN ('business', 'enterprise')
          AND billing.entitlement_scope = 'organization'
          AND billing.entitlement_plan = organization_entitlement.plan
          AND billing.entitlement_revision = organization_entitlement.revision
          AND organization_entitlement.status IN ('active', 'trialing')
          AND organization_entitlement.cloud_workspaces_allowed
          AND organization_entitlement.valid_from <= clock_timestamp()
          AND (organization_entitlement.valid_until IS NULL OR organization_entitlement.valid_until > clock_timestamp())
          AND EXISTS (SELECT 1 FROM organization_seat_assignments seat
            WHERE seat.org_id = workspace.org_id AND seat.user_id = target_user_id AND seat.state = 'active')
          AND (SELECT count(*) FROM organization_seat_assignments seat
            WHERE seat.org_id = workspace.org_id AND seat.state = 'active') <= organization_entitlement.seat_limit)
      )
  )
$function$;

