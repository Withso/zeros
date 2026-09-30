-- Provider accounts remain private to their human owner. Organization
-- association is not an organization-wide credential grant.
ALTER TABLE cloud_agent_credentials ADD COLUMN connection_method text NOT NULL DEFAULT 'api' CHECK(connection_method IN ('api','account'));
UPDATE cloud_agent_credentials SET connection_method='account' WHERE kind IN ('claude-setup-token','codex-chatgpt');
CREATE TABLE cloud_agent_credential_organizations (
  credential_id uuid NOT NULL,
  org_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, owner_user_id, credential_id),
  FOREIGN KEY (credential_id, owner_user_id) REFERENCES cloud_agent_credentials(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, owner_user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE
);
-- Retain discoverability for accounts explicitly used by released clients.
INSERT INTO cloud_agent_credential_organizations(credential_id,org_id,owner_user_id)
  SELECT DISTINCT delegation.credential_id,delegation.org_id,delegation.owner_user_id
  FROM cloud_agent_credential_delegations delegation
  JOIN cloud_agent_credentials credential ON credential.id=delegation.credential_id AND credential.revoked_at IS NULL
  JOIN organization_members member ON member.org_id=delegation.org_id AND member.user_id=delegation.owner_user_id
  JOIN organizations organization ON organization.id=delegation.org_id AND NOT organization.is_personal
  WHERE delegation.revoked_at IS NULL ON CONFLICT DO NOTHING;
CREATE TABLE cloud_agent_organization_connections (
  org_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('claude','codex','cursor')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  credential_id uuid,
  credential_revision bigint CHECK (credential_revision > 0),
  models text[] NOT NULL DEFAULT '{}' CHECK (cardinality(models) <= 32 AND array_position(models,NULL) IS NULL),
  consent_fingerprint text NOT NULL CHECK (consent_fingerprint ~ '^[a-f0-9]{64}$'),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256)=32),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, owner_user_id, provider),
  FOREIGN KEY (credential_id, owner_user_id) REFERENCES cloud_agent_credentials(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, owner_user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE,
  CHECK ((credential_id IS NULL AND credential_revision IS NULL AND cardinality(models)=0)
    OR (credential_id IS NOT NULL AND credential_revision IS NOT NULL AND cardinality(models)>0))
);
ALTER TABLE cloud_agent_credential_delegations
  ADD COLUMN organization_provider text CHECK (organization_provider IN ('claude','codex','cursor')),
  ADD COLUMN organization_connection_revision bigint CHECK (organization_connection_revision > 0),
  ADD CONSTRAINT organization_agent_consent_binding CHECK (
    (organization_provider IS NULL) = (organization_connection_revision IS NULL)
    AND (organization_provider IS NULL OR owner_user_id=grantee_user_id)
  );
CREATE INDEX cloud_agent_organization_delegations ON cloud_agent_credential_delegations(org_id,owner_user_id,organization_provider)
  WHERE organization_provider IS NOT NULL AND revoked_at IS NULL;

ALTER TABLE cloud_agent_credential_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_credential_organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_agent_credential_organizations_system ON cloud_agent_credential_organizations FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_agent_organization_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_organization_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_agent_organization_connections_system ON cloud_agent_organization_connections FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_agent_credential_organizations,cloud_agent_organization_connections TO zeros_app;
