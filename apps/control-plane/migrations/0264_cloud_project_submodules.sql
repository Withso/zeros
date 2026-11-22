-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Cloud submodules per project repository (C4). Off by default: a project's
-- builds and creates make no submodule reads until a repository turns it on.
--
-- cloud_submodule_levels remembers one level of a repository at a commit: its
-- .gitmodules entries and their gitlink commits, a pure function of that
-- commit with nothing about who may read it. The tree is composed per request,
-- and a level is read only after the caller's access to that repository is
-- checked (cloud/submodules.ts).
--
-- cloud_v2_workspace_submodule_sources: the submodule repositories a
-- workspace's creator could read at create. Token sources only: a submodule is
-- never in cloud_v2_github_sources, so execution signatures, source lists and
-- team admission are unchanged.
--
-- Down path (never run automatically):
--   DROP TABLE cloud_v2_workspace_submodule_sources, cloud_submodule_levels;
--   ALTER TABLE cloud_project_repositories DROP COLUMN fetch_submodules;

ALTER TABLE cloud_project_repositories ADD COLUMN fetch_submodules boolean NOT NULL DEFAULT false;

CREATE TABLE cloud_submodule_levels (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,19}$'),
  commit text NOT NULL CHECK (commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  level jsonb NOT NULL CHECK (jsonb_typeof(level) = 'object' AND pg_column_size(level) <= 131072),
  read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, repository_id, commit)
);
CREATE INDEX cloud_submodule_levels_read_at ON cloud_submodule_levels (read_at);

CREATE TABLE cloud_v2_workspace_submodule_sources (
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,19}$'),
  repository text NOT NULL CHECK (repository ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'),
  PRIMARY KEY (workspace_id, repository_id)
);
CREATE INDEX cloud_v2_workspace_submodule_sources_repository ON cloud_v2_workspace_submodule_sources (workspace_id, repository);

ALTER TABLE cloud_submodule_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_submodule_levels FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_submodule_levels USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_workspace_submodule_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_workspace_submodule_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_workspace_submodule_sources USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, DELETE ON cloud_submodule_levels, cloud_v2_workspace_submodule_sources TO zeros_app;
