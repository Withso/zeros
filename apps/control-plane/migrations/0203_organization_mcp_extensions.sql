-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Only the native GitHub user/App intersection can populate project choices.
-- This is metadata with bounded authority, never a GitHub token store. It also
-- supports organization-local work without a Cloud Computer recipe/build.
CREATE TABLE organization_mcp_repositories (
  org_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  repository text NOT NULL CHECK (repository = lower(repository) AND repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  default_branch text NOT NULL CHECK (length(default_branch) BETWEEN 1 AND 512),
  actor_fingerprint text NOT NULL CHECK (actor_fingerprint ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, owner_user_id, installation_id, repository),
  FOREIGN KEY (org_id, owner_user_id, installation_id) REFERENCES cloud_github_connections(org_id, owner_user_id, installation_id) ON DELETE CASCADE
);
ALTER TABLE organization_mcp_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_mcp_repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_mcp_repositories_system ON organization_mcp_repositories FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON organization_mcp_repositories TO zeros_app;

-- Public coordinates and encrypted values have one revision. A private entry
-- belongs to one member inside one organization, never the device Local owner.
CREATE TABLE organization_extensions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind = 'mcp'),
  repository text CHECK (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  revision integer NOT NULL CHECK (revision > 0),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  secret_names jsonb NOT NULL CHECK (jsonb_typeof(secret_names) = 'object'),
  secret_envelope jsonb NOT NULL CHECK (jsonb_typeof(secret_envelope) = 'object'),
  oauth_binding text NOT NULL CHECK (oauth_binding ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (org_id, owner_user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX organization_extensions_name ON organization_extensions
  (org_id, owner_user_id, kind, repository, (config->>'name')) NULLS NOT DISTINCT;

-- OAuth is always personal, including a shared server definition. An admin's
-- sign-in never silently grants that admin's service account to other members.
CREATE TABLE organization_mcp_oauth (
  extension_id uuid NOT NULL REFERENCES organization_extensions(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  binding text NOT NULL CHECK (binding ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL CHECK (revision > 0),
  envelope jsonb NOT NULL,
  refresh_claim uuid,
  refresh_started_at timestamptz,
  access_expires_at timestamptz,
  refreshable boolean NOT NULL DEFAULT false,
  sign_in_revision integer NOT NULL DEFAULT 1 CHECK (sign_in_revision > 0),
  PRIMARY KEY (extension_id, owner_user_id),
  FOREIGN KEY (org_id, owner_user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE
);
CREATE TABLE organization_mcp_oauth_attempts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  extension_id uuid REFERENCES organization_extensions(id) ON DELETE CASCADE,
  expected_revision integer,
  binding text NOT NULL CHECK (binding ~ '^[a-f0-9]{64}$'),
  state_hash bytea NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('preparing','pending','exchanging','connected','failed','cancelled','used')),
  envelope jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (org_id, owner_user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX organization_mcp_oauth_attempt_owner ON organization_mcp_oauth_attempts (org_id, owner_user_id, expires_at);

-- The service authenticates membership/role on every operation. Secret tables
-- are additionally inaccessible to an ordinary user-context SQL transaction.
ALTER TABLE organization_extensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_extensions FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_extensions_system ON organization_extensions FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE organization_mcp_oauth ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_mcp_oauth FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_mcp_oauth_system ON organization_mcp_oauth FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE organization_mcp_oauth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_mcp_oauth_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_mcp_oauth_attempts_system ON organization_mcp_oauth_attempts FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON organization_extensions, organization_mcp_oauth, organization_mcp_oauth_attempts TO zeros_app;

-- Existing worker revision/push machinery carries edits without a new poller.
-- Both sides of a scope move invalidate; stopped VMs remain stopped.
CREATE FUNCTION organization_mcp_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous public.organization_extensions; following public.organization_extensions;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous := OLD; END IF;
  IF TG_OP <> 'DELETE' THEN following := NEW; END IF;
  UPDATE public.cloud_v2_workspaces w SET login_revision = login_revision + 1
    WHERE w.state <> 'deleted' AND (
      (w.org_id = previous.org_id AND (previous.owner_user_id IS NULL OR w.creator_user_id = previous.owner_user_id)
        AND (previous.repository IS NULL OR lower(w.repository) = previous.repository)) OR
      (w.org_id = following.org_id AND (following.owner_user_id IS NULL OR w.creator_user_id = following.owner_user_id)
        AND (following.repository IS NULL OR lower(w.repository) = following.repository)));
  IF FOUND THEN
    PERFORM pg_notify('zeros_cloud_v2_logins', json_build_object('ownerUserId', NULL, 'organizationId', coalesce(following.org_id, previous.org_id))::text);
  END IF;
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION organization_mcp_changed() FROM PUBLIC;
CREATE TRIGGER organization_mcp_changed AFTER INSERT OR UPDATE OR DELETE ON organization_extensions
  FOR EACH ROW EXECUTE FUNCTION organization_mcp_changed();

-- Completing or withdrawing personal sign-in changes provider readiness even
-- when the shared definition is unchanged. Ordinary token renewal is demand
-- driven and does not restart native providers or publish another config.
CREATE FUNCTION organization_mcp_sign_in_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target public.organization_mcp_oauth; server public.organization_extensions;
BEGIN
  IF TG_OP = 'DELETE' THEN target := OLD; ELSE target := NEW; END IF;
  SELECT * INTO server FROM public.organization_extensions WHERE id = target.extension_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE public.cloud_v2_workspaces w SET login_revision = login_revision + 1
    WHERE w.org_id = target.org_id AND w.creator_user_id = target.owner_user_id AND w.state <> 'deleted'
      AND (server.repository IS NULL OR lower(w.repository) = server.repository);
  IF FOUND THEN
    PERFORM pg_notify('zeros_cloud_v2_logins', json_build_object('ownerUserId', target.owner_user_id, 'organizationId', target.org_id)::text);
  END IF;
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION organization_mcp_sign_in_changed() FROM PUBLIC;
CREATE TRIGGER organization_mcp_sign_in_changed AFTER INSERT OR DELETE OR UPDATE OF sign_in_revision ON organization_mcp_oauth
  FOR EACH ROW EXECUTE FUNCTION organization_mcp_sign_in_changed();
