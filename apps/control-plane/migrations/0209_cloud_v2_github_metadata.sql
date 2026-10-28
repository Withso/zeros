-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Published repository identity and observed checkout state are independent of
-- the original repository/path and source provenance on the workspace row.
CREATE TABLE cloud_v2_github_workspaces (
  workspace_id uuid PRIMARY KEY REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  repository_id bigint CHECK (repository_id > 0),
  canonical_repository text CHECK (canonical_repository ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  repository_aliases text[] NOT NULL DEFAULT '{}',
  checkout_boot_id uuid,
  checkout_sequence bigint NOT NULL DEFAULT 0 CHECK (checkout_sequence >= 0),
  checkout_revision bigint NOT NULL DEFAULT 0 CHECK (checkout_revision >= 0),
  branch text CHECK (branch IS NULL OR char_length(branch) BETWEEN 1 AND 255),
  base_branch text CHECK (base_branch IS NULL OR char_length(base_branch) BETWEEN 1 AND 255),
  head_sha text CHECK (head_sha IS NULL OR head_sha ~ '^[a-f0-9]{40}$'),
  pr_number integer CHECK (pr_number > 0),
  pr_state text CHECK (pr_state IN ('draft','ready','merged','closed')),
  pr_url text CHECK (pr_url IS NULL OR char_length(pr_url) <= 1024),
  pr_connection_generation text CHECK (pr_connection_generation IS NULL OR char_length(pr_connection_generation) BETWEEN 1 AND 128),
  mutation_lease uuid,
  mutation_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((repository_id IS NULL) = (canonical_repository IS NULL)),
  CHECK ((pr_number IS NULL) = (pr_state IS NULL) AND (pr_number IS NULL) = (pr_url IS NULL))
);
ALTER TABLE cloud_v2_github_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_github_workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_github_workspaces USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_v2_github_workspaces TO zeros_app;
