-- Authenticated GitHub profile data, never the member's personal email. Old
-- connections are populated on their next normal installation refresh.
ALTER TABLE github_authorizations
  ADD COLUMN github_user_id bigint CHECK (github_user_id > 0),
  ADD COLUMN git_author_name text CHECK (length(git_author_name) BETWEEN 1 AND 256);

-- Account replacement must invalidate source/write grants even if a GitHub
-- login has been reassigned. Display-name refreshes do not change authority.
CREATE OR REPLACE FUNCTION cloud_github_actor_fingerprint(target_org_id uuid,target_user_id uuid)
RETURNS text LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT encode(digest(jsonb_build_array(account.id,account.auth_revision,organization.id,organization.authorization_revision,
    member.authorization_revision,member.created_at,github_auth.github_login,github_auth.github_user_id,github_auth.created_at)::text,'sha256'),'hex')
  FROM organization_members member JOIN users account ON account.id=member.user_id
  JOIN organizations organization ON organization.id=member.org_id
  JOIN github_authorizations github_auth ON github_auth.owner_user_id=member.user_id AND github_auth.app_variant='github.com'
  WHERE member.org_id=target_org_id AND member.user_id=target_user_id
    AND account.auth_status='active' AND account.deleted_at IS NULL AND organization.deleted_at IS NULL AND NOT organization.is_personal AND app_is_system()
$$;
