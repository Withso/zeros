-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- GitHub at two levels (CLOUD_V2_READY_COPIES_ENABLED). Additive: nothing
-- here is read while the setting is off, and the data migration that fills it
-- (cloud/repository-levels.ts migrateRepositoryLevels) only inserts rows it
-- marks as migrated, so it can be undone until the setting is on.
--
-- Down path (never run automatically):
--   DROP TABLE cloud_repositories, cloud_github_installations;
--   ALTER TABLE cloud_v2_workspaces DROP COLUMN private_owner_user_id;
--   ALTER TABLE organizations DROP COLUMN cloud_personal_repositories_allowed;

-- A GitHub App installation recorded for an organization: once per
-- organization at the organization level. Organization level: added by owners and admins, used by
-- everyone. Personal level: one member's link, visible to that member only.
-- A migrated organization connection waits for its installation ID until an
-- admin connects it or the App reports it for one of its repositories.
CREATE TABLE cloud_github_installations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  installation_id bigint CHECK (installation_id IS NULL OR installation_id > 0),
  account_login text NOT NULL CHECK (account_login ~ '^[A-Za-z0-9_.-]{1,100}$'),
  level text NOT NULL CHECK (level IN ('organization','personal')),
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  -- active, or the edge state GitHub last reported.
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','suspended','uninstalled')),
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  migrated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((level = 'organization') = (owner_user_id IS NULL))
);
CREATE UNIQUE INDEX cloud_github_installations_once ON cloud_github_installations (org_id, installation_id)
  WHERE installation_id IS NOT NULL AND level = 'organization';
-- A member's own link; connecting it for the organization moves it up.
CREATE UNIQUE INDEX cloud_github_installations_personal ON cloud_github_installations (org_id, owner_user_id, installation_id)
  WHERE level = 'personal';
CREATE UNIQUE INDEX cloud_github_installations_unbound ON cloud_github_installations (org_id, lower(account_login))
  WHERE installation_id IS NULL AND level = 'organization';

-- A repository added to the cloud, at the level of the connection it came
-- through. Shared: the organization's; private: one member's, never shown to
-- anyone else. Shared wins: sharing folds every private entry into it.
CREATE TABLE cloud_repositories (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  repository text NOT NULL CHECK (repository ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'),
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,19}$'),
  level text NOT NULL CHECK (level IN ('shared','private')),
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  installation uuid REFERENCES cloud_github_installations(id) ON DELETE SET NULL,
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  migrated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  folded_at timestamptz,
  CHECK ((level = 'shared') = (owner_user_id IS NULL)),
  CHECK (level = 'private' OR folded_at IS NULL)
);
CREATE UNIQUE INDEX cloud_repositories_shared ON cloud_repositories (org_id, repository_id) WHERE level = 'shared';
CREATE UNIQUE INDEX cloud_repositories_private ON cloud_repositories (org_id, owner_user_id, repository_id) WHERE level = 'private' AND folded_at IS NULL;
CREATE INDEX cloud_repositories_member ON cloud_repositories (org_id, owner_user_id) WHERE level = 'private' AND folded_at IS NULL;

-- A workspace of a private repository: its member's alone. Never in team
-- lists, admin actions or the organization audit log, and never reassigned.
ALTER TABLE cloud_v2_workspaces ADD COLUMN private_owner_user_id uuid;
CREATE INDEX cloud_v2_workspaces_private ON cloud_v2_workspaces (org_id, private_owner_user_id) WHERE private_owner_user_id IS NOT NULL;

-- Whether members may add repositories for themselves. When forbidden,
-- private repositories stop refreshing and creating; their workspaces keep working.
ALTER TABLE organizations ADD COLUMN cloud_personal_repositories_allowed boolean NOT NULL DEFAULT true;

ALTER TABLE cloud_github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_github_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_github_installations USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_repositories USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_github_installations, cloud_repositories TO zeros_app;
