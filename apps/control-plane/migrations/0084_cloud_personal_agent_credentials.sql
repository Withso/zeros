-- Personal provider authority is independent of organization administration,
-- workspace compute sponsorship, and repository/environment secrets.
CREATE TABLE cloud_agent_credentials (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('claude-api-key','claude-setup-token','cursor-api-key','codex-api-key','codex-chatgpt')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version>0),
  last_operation_id uuid NOT NULL,
  last_request_sha256 bytea NOT NULL CHECK(octet_length(last_request_sha256)=32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(id,owner_user_id)
);
CREATE INDEX cloud_agent_credentials_owner ON cloud_agent_credentials(owner_user_id,id);
CREATE TABLE cloud_agent_credential_versions (
  credential_id uuid NOT NULL REFERENCES cloud_agent_credentials(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK(version>0),
  key_version integer NOT NULL CHECK(key_version>0),
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 36864),
  auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),
  material_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(credential_id,version)
);
CREATE TABLE cloud_agent_credential_delegations (
  id uuid PRIMARY KEY,
  credential_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  credential_revision bigint NOT NULL CHECK(credential_revision>0),
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  grantee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_fingerprint text NOT NULL CHECK(owner_fingerprint ~ '^[a-f0-9]{64}$'),
  grantee_fingerprint text NOT NULL CHECK(grantee_fingerprint ~ '^[a-f0-9]{64}$'),
  compute_fingerprint text NOT NULL CHECK(compute_fingerprint ~ '^[a-f0-9]{64}$'),
  compute_trust text NOT NULL CHECK(compute_trust IN ('zeros-managed','compute-administrator')),
  models text[] NOT NULL CHECK(cardinality(models) BETWEEN 1 AND 32 AND array_position(models,NULL) IS NULL),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY(credential_id,owner_user_id) REFERENCES cloud_agent_credentials(id,owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days')
);
CREATE INDEX cloud_agent_delegation_workspace ON cloud_agent_credential_delegations(workspace_id,grantee_user_id) WHERE revoked_at IS NULL;
CREATE INDEX cloud_agent_delegation_credential ON cloud_agent_credential_delegations(credential_id);

-- A runtime's own protocol integer is not proof of a qualified credential
-- boundary. Only the database operator can admit a provider/image/auth tuple.
CREATE TABLE cloud_agent_runtime_qualifications (
  provider text NOT NULL CHECK(provider IN ('boat','daytona')),
  image_ref text NOT NULL CHECK(length(image_ref) BETWEEN 1 AND 512),
  runtime_contract_sha256 text NOT NULL CHECK(runtime_contract_sha256 ~ '^[a-f0-9]{64}$'),
  credential_kind text NOT NULL CHECK(credential_kind IN ('claude-api-key','claude-setup-token','cursor-api-key','codex-api-key','codex-chatgpt')),
  profile text NOT NULL CHECK(profile='zeros-cloud-worker-v3'),
  enabled boolean NOT NULL DEFAULT false,
  qualified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,image_ref,runtime_contract_sha256,credential_kind)
);
ALTER TABLE cloud_workspace_engine_instances
  ADD COLUMN agent_runtime_profile text CHECK(agent_runtime_profile='zeros-cloud-worker-v3'),
  ADD COLUMN agent_runtime_contract_sha256 text CHECK(agent_runtime_contract_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT cloud_agent_runtime_binding CHECK((agent_runtime_profile IS NULL)=(agent_runtime_contract_sha256 IS NULL));

CREATE TABLE cloud_agent_execution_leases (
  id uuid PRIMARY KEY,
  delegation_id uuid NOT NULL REFERENCES cloud_agent_credential_delegations(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL REFERENCES cloud_agent_credentials(id) ON DELETE CASCADE,
  credential_revision bigint NOT NULL CHECK(credential_revision>0),
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL,
  engine_instance_id uuid NOT NULL,
  actor_source_session_id uuid NOT NULL REFERENCES cloud_workspace_actor_sessions(id) ON DELETE CASCADE,
  command_id uuid,
  command_claim_id uuid,
  execution_id text NOT NULL CHECK(execution_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  provider text NOT NULL CHECK(provider IN ('claude','cursor','codex')),
  model text NOT NULL CHECK(model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  FOREIGN KEY(engine_instance_id,workspace_id,generation,org_id)
    REFERENCES cloud_workspace_engine_instances(id,workspace_id,generation,org_id) ON DELETE CASCADE,
  CHECK((command_id IS NULL)=(command_claim_id IS NULL)),
  CHECK(expires_at>created_at),
  UNIQUE(engine_instance_id,execution_id)
);
CREATE INDEX cloud_agent_execution_expiry ON cloud_agent_execution_leases(expires_at) WHERE released_at IS NULL;
CREATE INDEX cloud_agent_execution_delegation ON cloud_agent_execution_leases(delegation_id);

ALTER TABLE cloud_agent_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_agent_credentials_system ON cloud_agent_credentials FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_agent_credential_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_credential_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_agent_credential_versions_system ON cloud_agent_credential_versions FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_agent_credential_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_credential_delegations FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_agent_credential_delegations_system ON cloud_agent_credential_delegations FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_agent_execution_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_execution_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_agent_execution_leases_system ON cloud_agent_execution_leases FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_agent_runtime_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_runtime_qualifications FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_agent_runtime_qualification_read ON cloud_agent_runtime_qualifications FOR SELECT USING(app_is_system());
CREATE POLICY cloud_agent_runtime_qualification_operator ON cloud_agent_runtime_qualifications FOR ALL
  USING(current_user<>'zeros_app') WITH CHECK(current_user<>'zeros_app');
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_agent_credentials,cloud_agent_credential_versions,cloud_agent_credential_delegations,cloud_agent_execution_leases TO zeros_app;
GRANT SELECT ON cloud_agent_runtime_qualifications TO zeros_app;
