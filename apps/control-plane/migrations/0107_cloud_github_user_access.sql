-- A GitHub installation can expose more repositories than its connecting
-- human may read. Cloud source admission requires both authorities.
CREATE TABLE cloud_github_connections (
  org_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  installation_id uuid NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  connected_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,owner_user_id,installation_id),
  FOREIGN KEY(org_id,owner_user_id) REFERENCES organization_members(org_id,user_id) ON DELETE CASCADE
);
CREATE TABLE cloud_github_source_access (
  org_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  repository_owner text NOT NULL CHECK(length(repository_owner) BETWEEN 1 AND 100),
  repository_name text NOT NULL CHECK(length(repository_name) BETWEEN 1 AND 100),
  forge_repository_id text NOT NULL CHECK(forge_repository_id ~ '^[1-9][0-9]{0,39}$'),
  actor_fingerprint text NOT NULL CHECK(actor_fingerprint ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(org_id,owner_user_id,installation_id,repository_owner,repository_name),
  FOREIGN KEY(org_id,owner_user_id,installation_id) REFERENCES cloud_github_connections(org_id,owner_user_id,installation_id) ON DELETE CASCADE,
  CHECK(repository_owner=lower(repository_owner) AND repository_name=lower(repository_name))
);
CREATE FUNCTION cloud_github_actor_fingerprint(target_org_id uuid,target_user_id uuid)
RETURNS text LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT encode(digest(jsonb_build_array(account.id,account.auth_revision,organization.id,organization.authorization_revision,
    member.authorization_revision,member.created_at,github_auth.github_login,github_auth.created_at)::text,'sha256'),'hex')
  FROM organization_members member JOIN users account ON account.id=member.user_id
  JOIN organizations organization ON organization.id=member.org_id
  JOIN github_authorizations github_auth ON github_auth.owner_user_id=member.user_id AND github_auth.app_variant='github.com'
  WHERE member.org_id=target_org_id AND member.user_id=target_user_id
    AND account.auth_status='active' AND account.deleted_at IS NULL AND organization.deleted_at IS NULL AND NOT organization.is_personal AND app_is_system()
$$;
REVOKE ALL ON FUNCTION cloud_github_actor_fingerprint(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_github_actor_fingerprint(uuid,uuid) TO zeros_app;
ALTER TABLE cloud_github_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_github_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_github_connections_system ON cloud_github_connections FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_github_source_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_github_source_access FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_github_source_access_system ON cloud_github_source_access FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_github_connections,cloud_github_source_access TO zeros_app;
