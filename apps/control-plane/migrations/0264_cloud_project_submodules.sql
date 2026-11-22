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
-- cloud_v2_workspace_submodules: each workspace repository's submodules as its
-- creator could read them at create. 'fetch' rows are the plan the worker brings
-- its checkouts to, and the only submodule repositories a token is minted for
-- (read-only), unless GitHub reported the repository public, which is fetched with no credential and no token;
-- 'readable' rows are submodules the project's copy holds that the
-- creator can read; 'skipped' rows are named to the person. A copy holding a
-- submodule the creator can't read is never forked for this workspace. A
-- submodule is never in cloud_v2_github_sources, so execution signatures, source
-- lists and team admission are unchanged.
--
-- Down path (never run automatically):
--   DROP TABLE cloud_v2_workspace_submodules, cloud_submodule_levels;
--   ALTER TABLE cloud_v2_ready_copies DROP COLUMN trigger_detail;
--   ALTER TABLE cloud_project_repositories DROP COLUMN fetch_submodules;

ALTER TABLE cloud_project_repositories ADD COLUMN fetch_submodules boolean NOT NULL DEFAULT false;

-- Changing the switch rebuilds the copy under trigger 'setup_changed' (its CHECK is left as it is); this
-- names the finer reason for the project page's history only.
ALTER TABLE cloud_v2_ready_copies ADD COLUMN trigger_detail text CHECK (trigger_detail IS NULL OR trigger_detail IN ('submodules_changed'));

CREATE TABLE cloud_submodule_levels (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,19}$'),
  commit text NOT NULL CHECK (commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  level jsonb NOT NULL CHECK (jsonb_typeof(level) = 'object' AND pg_column_size(level) <= 131072),
  read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, repository_id, commit)
);
CREATE INDEX cloud_submodule_levels_read_at ON cloud_submodule_levels (read_at);

CREATE TABLE cloud_v2_workspace_submodules (
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 9),
  path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 1024),
  status text NOT NULL CHECK (status IN ('fetch','readable','skipped')),
  repository text CHECK (repository IS NULL OR repository ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'),
  repository_id text CHECK (repository_id IS NULL OR repository_id ~ '^[1-9][0-9]{0,19}$'),
  commit text CHECK (commit IS NULL OR commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  git_dir text CHECK (git_dir IS NULL OR git_dir ~ '^modules/[0-9a-f]{64}(/modules/[0-9a-f]{64}){0,2}$'),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 200),
  -- GitHub reported the repository public at this create: fetched with no credential and never a token target.
  public boolean NOT NULL DEFAULT false CHECK (NOT public OR status IN ('fetch','readable')),
  CHECK (status <> 'fetch' OR (repository IS NOT NULL AND repository_id IS NOT NULL AND commit IS NOT NULL AND git_dir IS NOT NULL)),
  CHECK (status <> 'readable' OR repository_id IS NOT NULL),
  PRIMARY KEY (workspace_id, position, path)
);
CREATE INDEX cloud_v2_workspace_submodules_fetch ON cloud_v2_workspace_submodules (workspace_id, repository) WHERE status = 'fetch';

ALTER TABLE cloud_submodule_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_submodule_levels FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_submodule_levels USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_workspace_submodules ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_workspace_submodules FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_workspace_submodules USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, DELETE ON cloud_submodule_levels, cloud_v2_workspace_submodules TO zeros_app;
