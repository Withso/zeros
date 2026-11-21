-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Ready copies (CLOUD_V2_READY_COPIES_ENABLED, default off). The Cloud
-- Computer becomes a base: its runtime, Git LFS and an optional install
-- script. Each repository gets a stopped Boat machine cloned and set up from
-- that base, and new workspaces fork it. Nothing here is read while the
-- setting is off, so released servers and desktops behave as before.
--
-- Down path (never run automatically): delete every ready copy machine at Boat
-- first, then
--   DROP TABLE cloud_v2_ready_copy_secrets, cloud_v2_ready_copy_forks, cloud_v2_ready_copies;
--   ALTER TABLE cloud_v2_computer_builds DROP COLUMN install_script, DROP COLUMN base_only, DROP COLUMN base_shared;
--   ALTER TABLE cloud_v2_computers DROP COLUMN install_script;

-- What an admin installs on top of Boat's image, run once per build as the
-- workspace user. Edited with the recipe and versioned by its revision.
ALTER TABLE cloud_v2_computers
  ADD COLUMN install_script text CHECK (install_script IS NULL OR octet_length(install_script) <= 16000);

-- What a build ran. A base-only build installs no repository; a shared one
-- made no machine and points at the shared Zeros base, which no organization
-- cleanup may delete.
ALTER TABLE cloud_v2_computer_builds
  ADD COLUMN install_script text CHECK (install_script IS NULL OR octet_length(install_script) <= 16000),
  ADD COLUMN base_only boolean NOT NULL DEFAULT false,
  ADD COLUMN base_shared boolean NOT NULL DEFAULT false;

-- One row per organization, repository and generation. Rows are provider
-- receipts: they outlive the organization row until Boat confirms deletion,
-- so there is no cascading foreign key.
CREATE TABLE cloud_v2_ready_copies (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  repository text NOT NULL CHECK (repository ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'),
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,19}$'),
  -- A private repository's copy belongs to its one member; NULL for a shared repository.
  owner_user_id uuid,
  generation integer NOT NULL CHECK (generation > 0),
  state text NOT NULL CHECK (state IN ('building','ready','failed','retired')),
  -- Boat's create or fork key for this generation's machine; replayed after a lost reply.
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  machine_id text UNIQUE CHECK (machine_id IS NULL OR char_length(machine_id) BETWEEN 1 AND 128),
  -- Set before the provider call, cleared once its machine ID is recorded.
  machine_pending boolean NOT NULL DEFAULT false,
  machine_deleted_at timestamptz,
  -- 'snapshot:<name>' for a Cloud Computer base, 'copy:<id>' for a refresh forked from the previous generation.
  built_from_base text CHECK (built_from_base IS NULL OR char_length(built_from_base) BETWEEN 1 AND 200),
  computer_build_id uuid,
  -- The member whose GitHub access cloned it.
  created_by uuid,
  branch text CHECK (branch IS NULL OR char_length(branch) BETWEEN 1 AND 255),
  commit_sha text CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40}$'),
  failure_reason text CHECK (failure_reason IS NULL OR failure_reason ~ '^[a-z0-9_]{1,64}$'),
  -- A newer Cloud Computer base exists, or the copy is near Boat's 14-day
  -- deletion of a stopped disk; workspaces no longer fork it.
  stale boolean NOT NULL DEFAULT false,
  -- Replaces a ready generation; refresh starts are rate-limited, first copies are not.
  refresh boolean NOT NULL DEFAULT false,
  stopped_at timestamptz,
  last_forked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  UNIQUE NULLS NOT DISTINCT (org_id, repository, owner_user_id, generation)
);
-- Concurrent requests for the same repository join one build.
CREATE UNIQUE INDEX cloud_v2_ready_copies_building ON cloud_v2_ready_copies (org_id, repository, owner_user_id) NULLS NOT DISTINCT WHERE state = 'building';
-- The pointer: at most one ready generation, switched in one transaction.
CREATE UNIQUE INDEX cloud_v2_ready_copies_ready ON cloud_v2_ready_copies (org_id, repository, owner_user_id) NULLS NOT DISTINCT WHERE state = 'ready';
CREATE INDEX cloud_v2_ready_copies_queue ON cloud_v2_ready_copies (created_at, id) WHERE state = 'building';
CREATE INDEX cloud_v2_ready_copies_cleanup ON cloud_v2_ready_copies (updated_at, id)
  WHERE state IN ('failed','retired') AND machine_deleted_at IS NULL;

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

-- Build secrets an admin sets for a shared repository. Sealed; opened only by
-- the ready copy builder, delivered to its setup on standard input and never
-- written to the machine's definition, disk or logs.
CREATE TABLE cloud_v2_ready_copy_secrets (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  repository text NOT NULL CHECK (repository ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object' AND pg_column_size(envelope) <= 262144),
  names text[] NOT NULL CHECK (cardinality(names) <= 64),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, repository)
);

ALTER TABLE cloud_v2_ready_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_ready_copies FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_ready_copies USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_ready_copy_forks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_ready_copy_forks FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_ready_copy_forks USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_ready_copy_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_ready_copy_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_ready_copy_secrets USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_v2_ready_copies, cloud_v2_ready_copy_forks, cloud_v2_ready_copy_secrets TO zeros_app;
