-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Names remain in the immutable source ledger; IDs identify what those names
-- meant when source was admitted. A rename never narrows the original ledger.
CREATE TABLE cloud_v2_github_sources (
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  source_repository text NOT NULL CHECK (source_repository=lower(source_repository)),
  repository_id bigint NOT NULL CHECK (repository_id > 0),
  PRIMARY KEY (workspace_id,source_repository)
);
ALTER TABLE cloud_v2_github_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_github_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_github_sources USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT,INSERT,DELETE ON cloud_v2_github_sources TO zeros_app;
-- Do not infer historical IDs from a reusable owner/name. Existing disks stay
-- retained and require verified provenance before a missing identity is filled.
