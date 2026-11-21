-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Cloud projects and their ready copies (CLOUD_V2_READY_COPIES_ENABLED,
-- default off). Nothing here is read while the setting is off. This replaces
-- the unreleased per-repository ready copies and repository levels of tasks
-- 4A and 4B, which never reached any database.
--
-- The Cloud Computer becomes tools only: runtime, Git LFS and an optional
-- install script. A project is a named set of one or more repositories, each
-- with its own branch and setup in that project; it belongs to the
-- organization (owners and admins manage it, members use it) or to one member
-- (nobody else sees it, admins included). One ready copy per project: a
-- stopped Boat machine with every repository cloned and set up, which new
-- workspaces fork.
--
-- Down path (never run automatically): delete every ready copy machine at Boat
-- first, then
--   DROP TABLE cloud_v2_ready_copy_secrets, cloud_v2_ready_copy_forks, cloud_v2_ready_copies,
--     cloud_project_repositories, cloud_projects, cloud_github_installations;
--   ALTER TABLE cloud_v2_workspaces DROP COLUMN private_owner_user_id, DROP COLUMN project_id;
--   ALTER TABLE organizations DROP COLUMN cloud_personal_projects_allowed;
--   ALTER TABLE cloud_v2_computer_builds DROP COLUMN install_script, DROP COLUMN base_only, DROP COLUMN base_shared;
--   ALTER TABLE cloud_v2_computers DROP COLUMN install_script;

-- What an admin installs on top of Boat's image, run once per build.
ALTER TABLE cloud_v2_computers
  ADD COLUMN install_script text CHECK (install_script IS NULL OR octet_length(install_script) <= 16000);
-- What a build ran. A base-only build installs no repository; a shared one
-- made no machine and points at the shared Zeros base, which no cleanup deletes.
ALTER TABLE cloud_v2_computer_builds
  ADD COLUMN install_script text CHECK (install_script IS NULL OR octet_length(install_script) <= 16000),
  ADD COLUMN base_only boolean NOT NULL DEFAULT false,
  ADD COLUMN base_shared boolean NOT NULL DEFAULT false;

-- Whether members may keep projects of their own. When forbidden, personal
-- projects stop refreshing and creating; their workspaces keep working.
ALTER TABLE organizations ADD COLUMN cloud_personal_projects_allowed boolean NOT NULL DEFAULT true;

-- A GitHub App installation recorded for an organization: once at the
-- organization level (owners and admins add it, everyone uses it), or as one
-- member's own link, visible to that member only. A migrated organization
-- connection waits for its installation ID until it is connected or GitHub
-- reports it for one of its repositories.
CREATE TABLE cloud_github_installations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  installation_id bigint CHECK (installation_id IS NULL OR installation_id > 0),
  account_login text NOT NULL CHECK (account_login ~ '^[A-Za-z0-9_.-]{1,100}$'),
  level text NOT NULL CHECK (level IN ('organization','personal')),
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','suspended','uninstalled')),
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  migrated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((level = 'organization') = (owner_user_id IS NULL))
);
CREATE UNIQUE INDEX cloud_github_installations_once ON cloud_github_installations (org_id, installation_id)
  WHERE installation_id IS NOT NULL AND level = 'organization';
CREATE UNIQUE INDEX cloud_github_installations_personal ON cloud_github_installations (org_id, owner_user_id, installation_id)
  WHERE level = 'personal';
CREATE UNIQUE INDEX cloud_github_installations_unbound ON cloud_github_installations (org_id, lower(account_login))
  WHERE installation_id IS NULL AND level = 'organization';

CREATE TABLE cloud_projects (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  level text NOT NULL CHECK (level IN ('organization','personal')),
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  migrated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((level = 'organization') = (owner_user_id IS NULL))
);
CREATE UNIQUE INDEX cloud_projects_organization_name ON cloud_projects (org_id, lower(name)) WHERE level = 'organization';
CREATE UNIQUE INDEX cloud_projects_personal_name ON cloud_projects (org_id, owner_user_id, lower(name)) WHERE level = 'personal';
CREATE INDEX cloud_projects_member ON cloud_projects (org_id, owner_user_id) WHERE level = 'personal';

-- A repository in a project, with that project's own branch and setup.
CREATE TABLE cloud_project_repositories (
  project_id uuid NOT NULL REFERENCES cloud_projects(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  repository text NOT NULL CHECK (repository ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'),
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,19}$'),
  connection uuid REFERENCES cloud_github_installations(id) ON DELETE SET NULL,
  -- A branch or tag to clone; null is the repository's default branch.
  default_branch text CHECK (default_branch IS NULL OR (char_length(default_branch) BETWEEN 1 AND 255 AND default_branch !~ '^-')),
  setup text CHECK (setup IS NULL OR octet_length(setup) <= 8000),
  setup_script text CHECK (setup_script IS NULL OR char_length(setup_script) BETWEEN 1 AND 512),
  PRIMARY KEY (project_id, repository_id),
  UNIQUE (project_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX cloud_project_repositories_repository ON cloud_project_repositories (repository_id);

-- A workspace's project, and for a personal project its member: such a
-- workspace is never in team lists, admin actions or the audit log, and
-- never reassigned.
ALTER TABLE cloud_v2_workspaces ADD COLUMN private_owner_user_id uuid, ADD COLUMN project_id uuid;
CREATE INDEX cloud_v2_workspaces_private ON cloud_v2_workspaces (org_id, private_owner_user_id) WHERE private_owner_user_id IS NOT NULL;

-- One row per project and generation. Rows are provider receipts: they outlive
-- their project until Boat confirms deletion, so there is no cascading key.
CREATE TABLE cloud_v2_ready_copies (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  state text NOT NULL CHECK (state IN ('building','ready','failed','retired')),
  -- Boat's create or fork key for this generation's machine; replayed after a lost reply.
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  machine_id text UNIQUE CHECK (machine_id IS NULL OR char_length(machine_id) BETWEEN 1 AND 128),
  machine_pending boolean NOT NULL DEFAULT false,
  machine_deleted_at timestamptz,
  -- 'snapshot:<name>' for a Cloud Computer base, 'copy:<id>' for a refresh forked from the previous generation.
  built_from_base text CHECK (built_from_base IS NULL OR char_length(built_from_base) BETWEEN 1 AND 200),
  computer_build_id uuid,
  created_by uuid,
  -- Each repository cloned: [{ repository, repositoryId, branch, commit }].
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'array' AND pg_column_size(result) <= 65536)),
  failure_reason text CHECK (failure_reason IS NULL OR failure_reason ~ '^[a-z0-9_]{1,64}$'),
  -- Which repository and step failed, and where: a path at most, never a value.
  failure_repository text CHECK (failure_repository IS NULL OR char_length(failure_repository) BETWEEN 1 AND 201),
  failure_step text CHECK (failure_step IS NULL OR failure_step ~ '^[a-z_]{1,32}$'),
  failure_detail text CHECK (failure_detail IS NULL OR char_length(failure_detail) BETWEEN 1 AND 1100),
  -- A failed setup's last output with every build secret redacted; a passing build keeps none.
  setup_output text CHECK (setup_output IS NULL OR octet_length(setup_output) <= 16384),
  detail_pruned_at timestamptz,
  -- A newer Cloud Computer base exists, or the copy is near Boat's 14-day deletion: no longer forked.
  stale boolean NOT NULL DEFAULT false,
  -- Replaces a ready generation; refresh starts are rate-limited, first copies are not.
  refresh boolean NOT NULL DEFAULT false,
  -- What the generation was built from; failures with the same inputs count toward the retry backoff.
  inputs text CHECK (inputs IS NULL OR inputs ~ '^[0-9a-f]{64}$'),
  manual_retry boolean NOT NULL DEFAULT false,
  -- Why it ran, stored when it was queued, never inferred.
  trigger text CHECK (trigger IS NULL OR trigger IN ('project_created','repositories_changed','weekly_update','computer_build',
    'setup_changed','branch_changed','secrets_changed','retry','manual')),
  triggered_by uuid,
  stopped_at timestamptz,
  last_forked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  UNIQUE (project_id, generation)
);
-- Concurrent requests for one project join one build; the pointer is one ready generation.
CREATE UNIQUE INDEX cloud_v2_ready_copies_building ON cloud_v2_ready_copies (project_id) WHERE state = 'building';
CREATE UNIQUE INDEX cloud_v2_ready_copies_ready ON cloud_v2_ready_copies (project_id) WHERE state = 'ready';
CREATE INDEX cloud_v2_ready_copies_queue ON cloud_v2_ready_copies (created_at, id) WHERE state = 'building';
CREATE INDEX cloud_v2_ready_copies_cleanup ON cloud_v2_ready_copies (updated_at, id)
  WHERE state IN ('failed','retired') AND machine_deleted_at IS NULL;
CREATE INDEX cloud_v2_ready_copies_organization ON cloud_v2_ready_copies (org_id, project_id);

-- Each workspace's fork of a ready copy, keyed for recovery. A lost reply is
-- recovered by replaying this key, never by the fork's name: Boat names every
-- fork "<source name> fork".
CREATE TABLE cloud_v2_ready_copy_forks (
  workspace_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  copy_id uuid NOT NULL REFERENCES cloud_v2_ready_copies(id),
  fork_key text NOT NULL UNIQUE CHECK (char_length(fork_key) BETWEEN 1 AND 200),
  sandbox_id text CHECK (sandbox_id IS NULL OR char_length(sandbox_id) BETWEEN 1 AND 128),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz
);
CREATE INDEX cloud_v2_ready_copy_forks_in_flight ON cloud_v2_ready_copy_forks (copy_id) WHERE completed_at IS NULL;

-- A project's build secrets, sealed; opened only by its ready copy build,
-- delivered to setup on standard input, never written to a machine's
-- definition, disk or logs.
CREATE TABLE cloud_v2_ready_copy_secrets (
  project_id uuid PRIMARY KEY REFERENCES cloud_projects(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object' AND pg_column_size(envelope) <= 262144),
  names text[] NOT NULL CHECK (cardinality(names) <= 64),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE cloud_github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_github_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_github_installations USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_projects FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_projects USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_project_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_project_repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_project_repositories USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_ready_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_ready_copies FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_ready_copies USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_ready_copy_forks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_ready_copy_forks FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_ready_copy_forks USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_ready_copy_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_ready_copy_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_ready_copy_secrets USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_github_installations, cloud_projects, cloud_project_repositories,
  cloud_v2_ready_copies, cloud_v2_ready_copy_forks, cloud_v2_ready_copy_secrets TO zeros_app;
