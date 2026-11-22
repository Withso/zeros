-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- One rule for whether an organization's cloud is on, used by every query that
-- used to read `cloud_workspaces_allowed` (with or without `NOT is_personal`):
--   * an organization: its cloud_workspaces_allowed, as before;
--   * a Personal organization: the channel's switch for the transaction
--     (app.cloud_personal, set explicitly by every transaction context from
--     CLOUD_V2_PERSONAL_CLOUD_ENABLED) AND its owner's Pro with cloud allowed,
--     read live (account_pro_active, 0216).
-- Nothing writes a Personal organization's column: the CHECK
-- personal_organizations_are_local_only (0009, 0053) stays, so a reader of the
-- bare column fails closed for Personal. The switch off is immediate and
-- complete; operator tools and migrations, which set no switch, see it off.
--
-- Down path (never run automatically): restore 0206's cloud_github_actor_fingerprint;
--   DROP FUNCTION cloud_organization_enabled(public.organizations);

CREATE FUNCTION cloud_organization_enabled(o public.organizations) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN o.is_personal
    THEN coalesce(current_setting('app.cloud_personal', true), '0') = '1' AND public.account_pro_active(o.created_by)
    ELSE o.cloud_workspaces_allowed END
$$;

GRANT EXECUTE ON FUNCTION cloud_organization_enabled(public.organizations) TO zeros_app;

-- A Personal organization with cloud on may connect GitHub like an organization.
-- The fingerprint's value is unchanged for every organization: only the row filter changes.
-- zeros-expand-exception: personal-cloud-fingerprint Same signature, same value and system-only visibility; a Personal organization is admitted only while cloud_organization_enabled.
CREATE OR REPLACE FUNCTION cloud_github_actor_fingerprint(target_org_id uuid,target_user_id uuid)
RETURNS text LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT encode(digest(jsonb_build_array(account.id,account.auth_revision,organization.id,organization.authorization_revision,
    member.authorization_revision,member.created_at,github_auth.github_user_id,github_auth.grant_generation)::text,'sha256'),'hex')
  FROM organization_members member JOIN users account ON account.id=member.user_id
  JOIN organizations organization ON organization.id=member.org_id
  JOIN github_authorizations github_auth ON github_auth.owner_user_id=member.user_id AND github_auth.app_variant='github.com'
  WHERE member.org_id=target_org_id AND member.user_id=target_user_id
    AND account.auth_status='active' AND account.deleted_at IS NULL AND organization.deleted_at IS NULL
    AND (NOT organization.is_personal OR cloud_organization_enabled(organization)) AND app_is_system()
$$;
