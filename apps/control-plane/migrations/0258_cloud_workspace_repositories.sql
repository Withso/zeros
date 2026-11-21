-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A workspace of a project holds each of the project's repositories. The
-- workspace row's own repository, branch, base_branch, base_commit and
-- setup_status stay the first repository's, so every existing reader and
-- trigger keeps working; position 0 below mirrors them (one row is backfilled
-- per existing workspace, and a trigger keeps it current for writers that only
-- know the workspace row, including the previous release during a deploy).
--
-- Layout: a workspace with a folder keeps each repository in its own folder
-- inside /home/user/<folder>; one without (every workspace made before
-- projects) keeps /home/user/<repository>. Both are fixed at creation.
--
-- Down path (never run automatically): DROP TRIGGER cloud_v2_first_repository ON cloud_v2_workspaces;
--   DROP FUNCTION cloud_v2_first_repository(); DROP TABLE cloud_workspace_environment_repository_pins,
--   cloud_v2_github_workspace_repositories, cloud_v2_workspace_repositories;
--   ALTER TABLE cloud_v2_workspaces DROP COLUMN checkout_path, DROP COLUMN folder;

-- checkout_path: the first repository's checkout under /home/user,
-- <project-folder>/<repository-folder>; folder: the project folder, only when
-- the workspace holds several repositories (the agent then works there, else in
-- the checkout). Both null for a workspace made before projects, whose
-- checkout stays /home/user/<repository>.
ALTER TABLE cloud_v2_workspaces
  ADD COLUMN folder text CHECK (folder IS NULL OR (folder ~ '^[a-z0-9][a-z0-9._-]{0,63}$' AND folder !~ '[.]$')),
  ADD COLUMN checkout_path text CHECK (checkout_path IS NULL OR checkout_path ~ '^[a-z0-9][a-z0-9._-]{0,63}/[A-Za-z0-9_.-]{1,100}$'),
  ADD CONSTRAINT cloud_v2_workspaces_folder CHECK (folder IS NULL OR (checkout_path IS NOT NULL AND checkout_path LIKE folder || '/%'));

CREATE TABLE cloud_v2_workspace_repositories (
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 9),
  repository text NOT NULL CHECK (repository ~ '^[^/]+/[^/]+$' AND char_length(repository) <= 512),
  -- Null until the workspace's sources are bound; position 0 reads cloud_v2_github_sources then.
  repository_id bigint CHECK (repository_id > 0),
  -- The repository's folder inside the workspace folder; null without one.
  folder text CHECK (folder IS NULL OR (folder ~ '^[A-Za-z0-9_.-]{1,100}$' AND folder NOT IN ('.', '..', '.git'))),
  branch text NOT NULL CHECK (char_length(branch) BETWEEN 1 AND 255),
  base_branch text NOT NULL CHECK (char_length(base_branch) BETWEEN 1 AND 255),
  base_commit text CHECK (base_commit IS NULL OR base_commit ~ '^[0-9a-f]{40}$'),
  setup_status jsonb CHECK (setup_status IS NULL OR (jsonb_typeof(setup_status) = 'object' AND pg_column_size(setup_status) <= 8192)),
  PRIMARY KEY (workspace_id, position)
);
CREATE UNIQUE INDEX cloud_v2_workspace_repositories_name ON cloud_v2_workspace_repositories (workspace_id, lower(repository));
CREATE UNIQUE INDEX cloud_v2_workspace_repositories_folder ON cloud_v2_workspace_repositories (workspace_id, folder) WHERE folder IS NOT NULL;
CREATE UNIQUE INDEX cloud_v2_workspace_repositories_id ON cloud_v2_workspace_repositories (workspace_id, repository_id) WHERE repository_id IS NOT NULL;

INSERT INTO cloud_v2_workspace_repositories (workspace_id, position, repository, repository_id, branch, base_branch, base_commit, setup_status)
SELECT w.id, 0, w.repository, s.repository_id, w.branch, w.base_branch, w.base_commit, w.setup_status
FROM cloud_v2_workspaces w
LEFT JOIN cloud_v2_github_sources s ON s.workspace_id = w.id AND s.source_repository = lower(w.repository)
ON CONFLICT DO NOTHING;

CREATE FUNCTION cloud_v2_first_repository() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO cloud_v2_workspace_repositories (workspace_id, position, repository, branch, base_branch, base_commit, setup_status)
  VALUES (NEW.id, 0, NEW.repository, NEW.branch, NEW.base_branch, NEW.base_commit, NEW.setup_status)
  ON CONFLICT (workspace_id, position) DO UPDATE SET repository = EXCLUDED.repository, branch = EXCLUDED.branch,
    base_branch = EXCLUDED.base_branch, base_commit = EXCLUDED.base_commit, setup_status = EXCLUDED.setup_status;
  RETURN NULL;
END $$;
CREATE TRIGGER cloud_v2_first_repository AFTER INSERT OR UPDATE OF repository, branch, base_branch, base_commit, setup_status
  ON cloud_v2_workspaces FOR EACH ROW EXECUTE FUNCTION cloud_v2_first_repository();

-- Pull request and checkout state of a workspace's repositories after the
-- first, keyed by (workspace, repository id); the first keeps
-- cloud_v2_github_workspaces, which released code reads.
CREATE TABLE cloud_v2_github_workspace_repositories (
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  repository_id bigint NOT NULL CHECK (repository_id > 0),
  canonical_repository text NOT NULL CHECK (canonical_repository ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
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
  PRIMARY KEY (workspace_id, repository_id),
  CHECK ((pr_number IS NULL) = (pr_state IS NULL) AND (pr_number IS NULL) = (pr_url IS NULL))
);

-- Environment pins of the repositories after the first, as cloud_workspace_environment_pins.
CREATE TABLE cloud_workspace_environment_repository_pins (
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id bigint NOT NULL CHECK (repository_id BETWEEN 1 AND 9007199254740991),
  version_id uuid NOT NULL,
  ready_boot_id uuid,
  PRIMARY KEY (workspace_id, repository_id),
  FOREIGN KEY (org_id, owner_user_id, repository_id, version_id)
    REFERENCES cloud_environment_versions(org_id, owner_user_id, repository_id, id) DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE cloud_v2_workspace_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_workspace_repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_workspace_repositories USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_github_workspace_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_github_workspace_repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_github_workspace_repositories USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_workspace_environment_repository_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_environment_repository_pins FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_workspace_environment_repository_pins USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_v2_workspace_repositories, cloud_v2_github_workspace_repositories,
  cloud_workspace_environment_repository_pins TO zeros_app;
