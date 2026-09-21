-- Native refresh state stays in the trusted control plane. Consent revision
-- and access-material version are deliberately independent.
CREATE TABLE cloud_codex_auth_caches (
  credential_id uuid PRIMARY KEY REFERENCES cloud_agent_credentials(id) ON DELETE CASCADE,
  credential_revision bigint NOT NULL CHECK(credential_revision>0),
  material_version integer NOT NULL CHECK(material_version>0),
  runtime_version text NOT NULL CHECK(runtime_version='0.154.0'),
  binding_sha256 bytea NOT NULL CHECK(octet_length(binding_sha256)=32),
  key_version integer NOT NULL CHECK(key_version>0),
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 65536),
  auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),
  state text NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','reserved','dispatched','uncertain')),
  attempt_id uuid,
  attempt_started_at timestamptz,
  refresh_after timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((state='ready' AND attempt_id IS NULL AND attempt_started_at IS NULL) OR
        (state<>'ready' AND attempt_id IS NOT NULL AND attempt_started_at IS NOT NULL))
);
-- Security tombstones survive account erasure without retaining an owner or
-- credential association. This prevents a purged in-flight native refresh
-- from racing another import of its seed. No tokens or timestamps are kept.
-- Dedicated fingerprint keys may not be removed while these fences exist;
-- ciphertext encryption keys have an independent retirement lifecycle.
CREATE TABLE cloud_codex_refresh_key_versions (
  key_version integer PRIMARY KEY CHECK(key_version BETWEEN 1 AND 65535),
  key_check bytea NOT NULL CHECK(octet_length(key_check)=32)
);
CREATE TABLE cloud_codex_refresh_fingerprints (
  key_version integer NOT NULL CHECK(key_version>0),
  fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32),
  credential_id uuid REFERENCES cloud_agent_credentials(id) ON DELETE SET NULL,
  PRIMARY KEY(key_version,fingerprint)
);
CREATE INDEX cloud_codex_refresh_fingerprint_credential ON cloud_codex_refresh_fingerprints(credential_id);
ALTER TABLE cloud_codex_auth_caches ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_codex_auth_caches FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_codex_auth_cache_system ON cloud_codex_auth_caches FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_codex_refresh_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_codex_refresh_fingerprints FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_codex_refresh_fingerprint_system ON cloud_codex_refresh_fingerprints FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_codex_refresh_key_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_codex_refresh_key_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_codex_refresh_keys_system ON cloud_codex_refresh_key_versions FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_codex_auth_caches,cloud_codex_refresh_fingerprints,cloud_codex_refresh_key_versions TO zeros_app;
