-- Additive: released writers omit material_mode and retain their local envelope.
ALTER TABLE cloud_agent_credential_versions
  ADD COLUMN material_mode text NOT NULL DEFAULT 'local',
  ADD COLUMN dev_reference jsonb,
  ALTER COLUMN key_version DROP NOT NULL,
  ALTER COLUMN nonce DROP NOT NULL,
  ALTER COLUMN ciphertext DROP NOT NULL,
  ALTER COLUMN auth_tag DROP NOT NULL,
  ADD CONSTRAINT cloud_agent_material_owner CHECK ((
    (material_mode='local' AND dev_reference IS NULL AND key_version IS NOT NULL AND nonce IS NOT NULL AND ciphertext IS NOT NULL AND auth_tag IS NOT NULL)
    OR (material_mode='dev-reference' AND key_version IS NULL AND nonce IS NULL AND ciphertext IS NULL AND auth_tag IS NULL
      AND dev_reference IS NOT NULL AND jsonb_typeof(dev_reference)='object'
      AND dev_reference->>'mode'='dev-reference'
      AND dev_reference ?& ARRAY['bindingId','connectionId','generationId','organization','revision','consentRevision']
      AND dev_reference->>'bindingId'=credential_id::text)) IS TRUE) ;

CREATE TABLE dev_connection_references (
  binding_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  workos_org_id text NOT NULL,
  generation_id uuid NOT NULL,
  reference jsonb NOT NULL CHECK(jsonb_typeof(reference)='object'),
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  invalidated_at timestamptz,
  removed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dev_connection_reference_owner ON dev_connection_references(owner_user_id,org_id,generation_id);
-- Only a bounded, original WorkOS access bearer; never an IdP refresh token.
CREATE TABLE dev_connection_sessions (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL,
  fingerprint text NOT NULL,
  expires_at timestamptz NOT NULL,
  key_version integer NOT NULL CHECK(key_version>0),
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 32768),
  auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),
  PRIMARY KEY(owner_user_id,org_id,generation_id)
);
CREATE TABLE dev_connection_cursors (
  generation_id uuid PRIMARY KEY,
  sequence bigint NOT NULL DEFAULT 0 CHECK(sequence>=0),
  checked_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['dev_connection_references','dev_connection_sessions','dev_connection_cursors'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY dev_connection_system ON %I FOR ALL USING(app_is_system()) WITH CHECK(app_is_system())',name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO zeros_app',name);
  END LOOP;
END $$;

-- Hosted Dev OAuth hands off only a broker binding. Legacy handoff bytes and
-- released writers remain unchanged.
CREATE TABLE dev_github_handoffs (
  nonce_hash bytea PRIMARY KEY CHECK(octet_length(nonce_hash)=32),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL REFERENCES dev_connection_references(binding_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
ALTER TABLE dev_github_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_github_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY dev_github_handoff_system ON dev_github_handoffs FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON dev_github_handoffs TO zeros_app;
