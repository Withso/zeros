-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

CREATE TABLE cloud_v2_runtime_canaries (
  grant_id uuid PRIMARY KEY,
  workspace_id uuid UNIQUE REFERENCES cloud_v2_workspaces(id) ON DELETE SET NULL,
  creator_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  repository_id bigint NOT NULL CHECK (repository_id BETWEEN 1 AND 9007199254740991),
  runtime_sha256 text NOT NULL CHECK (runtime_sha256 ~ '^[0-9a-f]{64}$'),
  source_sha text NOT NULL CHECK (source_sha ~ '^[0-9a-f]{40}$'),
  grant_sha256 text NOT NULL CHECK (grant_sha256 ~ '^[0-9a-f]{64}$'),
  create_key_sha256 text NOT NULL CHECK (create_key_sha256 ~ '^[0-9a-f]{64}$'),
  run_id text NOT NULL CHECK (run_id ~ '^[1-9][0-9]{0,19}$'),
  run_attempt integer NOT NULL CHECK (run_attempt BETWEEN 1 AND 10000),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes')
);

ALTER TABLE cloud_v2_runtime_canaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_runtime_canaries FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_runtime_canaries USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_v2_runtime_canaries TO zeros_app;
