-- zeros-migration: expand
-- Every OAuth completion establishes a new grant. A disconnected grant must
-- never become live again merely because the same account reconnects.
ALTER TABLE github_authorizations
  ADD COLUMN grant_generation uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE github_oauth_handoffs ADD COLUMN grant_generation uuid;

-- Existing bindings have no generation and must reconnect. Never attach an
-- old signed binding or pending handoff to the newly materialized generation.
-- zeros-expand-exception: grant-generation-fingerprint Same signature and system-only visibility; reconnects invalidate old grants through a new fingerprint input.
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
    AND account.auth_status='active' AND account.deleted_at IS NULL AND organization.deleted_at IS NULL AND NOT organization.is_personal AND app_is_system()
$$;
