-- One-use renderer admission becomes a short-lived backend proxy capability.
-- The GitHub App user token stays encrypted here; neither the engine nor a Git
-- subprocess receives it. Expiry/release deletes this temporary ciphertext.
CREATE TABLE cloud_github_write_grants (
  grant_hash bytea PRIMARY KEY CHECK(octet_length(grant_hash)=32),
  proxy_hash bytea UNIQUE CHECK(proxy_hash IS NULL OR octet_length(proxy_hash)=32),
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK(generation>0),
  actor_user_id uuid NOT NULL,
  actor_fingerprint text NOT NULL,
  github_fingerprint text NOT NULL,
  operation text NOT NULL CHECK(operation IN ('git.push','gh.prCreate','gh.prUpdate','gh.prMarkReady','gh.prMerge','gh.prComment')),
  params_sha256 text NOT NULL CHECK(params_sha256 ~ '^[a-f0-9]{64}$'),
  pr_number integer CHECK(pr_number>0),
  repository_id text NOT NULL,
  repository_owner text NOT NULL,
  repository_name text NOT NULL,
  token_sealed bytea NOT NULL,
  admission_expires_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  engine_instance_id uuid,
  actor_session_id uuid,
  claimed_at timestamptz,
  expected_body jsonb,
  git_reference text,
  api_write_started boolean NOT NULL DEFAULT false,
  git_write_started boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((engine_instance_id IS NULL)=(claimed_at IS NULL)),
  CHECK((engine_instance_id IS NULL)=(proxy_hash IS NULL)),
  CHECK((engine_instance_id IS NULL)=(actor_session_id IS NULL))
);
CREATE INDEX cloud_github_write_grants_cleanup ON cloud_github_write_grants(lease_expires_at);
CREATE INDEX cloud_github_write_grants_owner ON cloud_github_write_grants(actor_user_id,admission_expires_at);
ALTER TABLE cloud_github_write_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_github_write_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_github_write_grants_system ON cloud_github_write_grants FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_github_write_grants TO zeros_app;
