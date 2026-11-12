-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Fresh creates have no old VM to drain. Keep their initial runtime and
-- first cleanup outcome separate from an operator activation's Stop proof.
CREATE TABLE cloud_v2_execution_creations (
  workspace_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  runtime_sha256 text NOT NULL CHECK (runtime_sha256 ~ '^[a-f0-9]{64}$'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_sha text NOT NULL CHECK (source_sha ~ '^[a-f0-9]{40}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  clean_boot_id uuid,
  clean_at timestamptz,
  first_failed_boot_id uuid,
  first_failed_at timestamptz,
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_v2_workspaces(id,org_id) ON DELETE CASCADE,
  CHECK ((clean_boot_id IS NULL)=(clean_at IS NULL)),
  CHECK ((first_failed_boot_id IS NULL)=(first_failed_at IS NULL))
);
ALTER TABLE cloud_v2_execution_creations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_execution_creations FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_execution_creations USING(app_is_system()) WITH CHECK(app_is_system());
