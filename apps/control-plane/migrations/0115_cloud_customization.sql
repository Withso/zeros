-- Additive organization/member customization. Only the trusted control plane
-- can decrypt these documents; workspace actors receive execution snapshots.
ALTER TABLE cloud_agent_execution_leases ADD COLUMN customization_digest text CHECK (customization_digest ~ '^[a-f0-9]{64}$');
-- Existing images keep their original credential admission. MCP requires new
-- native evidence for that exact provider/image/contract/credential kind.
ALTER TABLE cloud_agent_runtime_qualifications ADD COLUMN mcp_qualified boolean NOT NULL DEFAULT false;
CREATE TABLE cloud_customization (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  key_version integer NOT NULL CHECK (key_version > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext)<=262144),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag)=16),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(org_id,owner_user_id) REFERENCES organization_members(org_id,user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX cloud_customization_organization ON cloud_customization(org_id) WHERE owner_user_id IS NULL;
CREATE UNIQUE INDEX cloud_customization_member ON cloud_customization(org_id,owner_user_id) WHERE owner_user_id IS NOT NULL;

CREATE TABLE cloud_customization_execution_snapshots (
  lease_id uuid PRIMARY KEY REFERENCES cloud_agent_execution_leases(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_revision bigint NOT NULL CHECK (organization_revision>=0),
  member_revision bigint NOT NULL CHECK (member_revision>=0),
  repository_digest text NOT NULL CHECK (repository_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  key_version integer NOT NULL CHECK (key_version>0),
  nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext)<=1048576),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag)=16)
);
ALTER TABLE cloud_customization ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_customization FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_customization_system ON cloud_customization FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_customization_execution_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_customization_execution_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_customization_snapshots_system ON cloud_customization_execution_snapshots FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_customization,cloud_customization_execution_snapshots TO zeros_app;
