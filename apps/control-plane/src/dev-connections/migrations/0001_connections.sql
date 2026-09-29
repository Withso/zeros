-- Dedicated persistent Dev database only. Never run the product migrations here.
CREATE SCHEMA dev_connections;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zeros_app') THEN
    CREATE ROLE zeros_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
CREATE TABLE dev_connections.members (
  id uuid PRIMARY KEY, issuer text NOT NULL, subject text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0), revoked_at timestamptz,
  UNIQUE (issuer, subject)
);
CREATE TABLE dev_connections.generations (
  id uuid PRIMARY KEY, owner text NOT NULL, organization text NOT NULL, audience text NOT NULL,
  credential_hash bytea NOT NULL CHECK (octet_length(credential_hash)=32), key_revision integer NOT NULL,
  expires_at timestamptz NOT NULL, source text NOT NULL CHECK (source='hosted-dev'), revoked_at timestamptz
);
CREATE TABLE dev_connections.connections (
  id uuid PRIMARY KEY, member_id uuid NOT NULL REFERENCES dev_connections.members(id), kind text NOT NULL,
  account_id text NOT NULL, app_scope text NOT NULL, request_hash bytea NOT NULL, connection_method text NOT NULL CHECK (connection_method IN ('account','api')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0), current_version integer NOT NULL DEFAULT 1 CHECK (current_version>0), revoked_at timestamptz
);
CREATE UNIQUE INDEX live_connection_account ON dev_connections.connections(member_id,kind,account_id,app_scope) WHERE revoked_at IS NULL;
CREATE TABLE dev_connections.connection_versions (
  connection_id uuid PRIMARY KEY REFERENCES dev_connections.connections(id), version integer NOT NULL,
  key_version integer NOT NULL, nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 70000), auth_tag bytea NOT NULL CHECK (octet_length(auth_tag)=16), expires_at timestamptz
);
CREATE TABLE dev_connections.organization_consents (
  connection_id uuid NOT NULL REFERENCES dev_connections.connections(id), organization text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0), models text[] NOT NULL, repositories text[] NOT NULL, scopes text[] NOT NULL,
  revoked_at timestamptz, PRIMARY KEY(connection_id,organization)
);
CREATE TABLE dev_connections.bindings (
  id uuid PRIMARY KEY, generation_id uuid NOT NULL REFERENCES dev_connections.generations(id), member_id uuid NOT NULL REFERENCES dev_connections.members(id),
  connection_id uuid NOT NULL REFERENCES dev_connections.connections(id), connection_revision integer NOT NULL,
  consent_revision integer NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
  UNIQUE(generation_id,connection_id)
);
CREATE TABLE dev_connections.refresh_attempts (
  id uuid PRIMARY KEY, connection_id uuid NOT NULL REFERENCES dev_connections.connections(id), revision integer NOT NULL, version integer NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved','dispatched','published','uncertain','abandoned')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), published_version integer
);
CREATE UNIQUE INDEX one_pending_refresh ON dev_connections.refresh_attempts(connection_id) WHERE state IN ('reserved','dispatched','uncertain');
CREATE TABLE dev_connections.fingerprint_keys (key_version integer PRIMARY KEY, key_check bytea NOT NULL);
-- Tombstones are never garbage-collected or restored independently of the journal.
CREATE TABLE dev_connections.refresh_fingerprints (
  key_version integer NOT NULL REFERENCES dev_connections.fingerprint_keys(key_version), fingerprint bytea NOT NULL,
  connection_id uuid NOT NULL REFERENCES dev_connections.connections(id), PRIMARY KEY(key_version,fingerprint)
);
CREATE TABLE dev_connections.grant_audit (
  id uuid PRIMARY KEY, binding_id uuid NOT NULL REFERENCES dev_connections.bindings(id), member_id uuid NOT NULL REFERENCES dev_connections.members(id),
  connection_revision integer NOT NULL, consent_revision integer NOT NULL, scope jsonb NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL, provider_expires_at timestamptz
);
CREATE TABLE dev_connections.revocation_outbox (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, generation_id uuid NOT NULL REFERENCES dev_connections.generations(id),
  binding_id uuid REFERENCES dev_connections.bindings(id), reason text NOT NULL CHECK (reason IN ('archive','disconnect','consent','generation-key')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX revocation_generation ON dev_connections.revocation_outbox(generation_id,sequence);
CREATE INDEX grant_retention ON dev_connections.grant_audit(issued_at);
GRANT USAGE ON SCHEMA dev_connections TO zeros_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA dev_connections TO zeros_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA dev_connections TO zeros_app;
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='dev_connections' LOOP
    EXECUTE format('ALTER TABLE dev_connections.%I ENABLE ROW LEVEL SECURITY',item.tablename);
    EXECUTE format('ALTER TABLE dev_connections.%I FORCE ROW LEVEL SECURITY',item.tablename);
    EXECUTE format('CREATE POLICY broker_only ON dev_connections.%I TO zeros_app USING (current_setting(''dev_connections.authority'',true)=''broker'') WITH CHECK (current_setting(''dev_connections.authority'',true)=''broker'')',item.tablename);
  END LOOP;
END $$;
