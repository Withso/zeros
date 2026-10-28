-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Cloud selection belongs to the person within the selected organization.
-- Local desktop authentication remains independent.
CREATE TABLE cloud_github_selections (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  selected_method text CHECK (selected_method IN ('github-app','pat')),
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (org_id,owner_user_id)
);
CREATE TABLE cloud_github_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('github-app','pat')),
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  github_user_id text NOT NULL CHECK (github_user_id ~ '^[1-9][0-9]{0,15}$'),
  github_login text NOT NULL CHECK (github_login ~ '^[A-Za-z0-9_.-]{1,100}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  key_version integer NOT NULL CHECK (key_version > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 16384),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag)=16),
  expires_at timestamptz,
  refresh_lease uuid,
  refresh_lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,owner_user_id,method),
  FOREIGN KEY (org_id,owner_user_id) REFERENCES cloud_github_selections(org_id,owner_user_id) ON DELETE CASCADE
);
CREATE TABLE cloud_github_oauth_states (
  state_hash bytea PRIMARY KEY CHECK (octet_length(state_hash)=32),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expected_generation text NOT NULL CHECK (char_length(expected_generation)=64),
  pkce_verifier text NOT NULL CHECK (char_length(pkce_verifier) BETWEEN 43 AND 128),
  expires_at timestamptz NOT NULL
);
CREATE INDEX cloud_github_oauth_states_expiry_idx ON cloud_github_oauth_states(expires_at);

ALTER TABLE cloud_github_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_github_selections FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_github_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_github_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_github_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_github_oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_github_selections USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY system_only ON cloud_github_credentials USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY system_only ON cloud_github_oauth_states USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_github_selections,cloud_github_credentials,cloud_github_oauth_states TO zeros_app;
