-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
-- A safe switch-on for ready copies (CLOUD_V2_READY_COPIES_ENABLED, src/cloud/base-preparation.ts). Nothing here is
-- read while that setting is off, except legacy_build_id, which only that setting writes.

-- A base Zeros prepared for an organization, with no person behind it: base-only, no source and no creator, so it
-- clones nothing and mints no token. Its builder runs Boat's stock image and the organization's install script.
ALTER TABLE cloud_v2_computer_builds ADD COLUMN automatic boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT cloud_v2_computer_builds_automatic_narrow CHECK (NOT automatic OR (base_only AND created_by IS NULL
    AND source_targets IS NOT NULL AND jsonb_typeof(source_targets) = 'array' AND jsonb_array_length(source_targets) = 0));
CREATE INDEX cloud_v2_computer_builds_automatic_started ON cloud_v2_computer_builds (started_at) WHERE automatic AND NOT base_shared;

-- The build that served creates before the organization's first base went live, and when that was. It is kept (never a
-- cleanup candidate) while a workspace is pinned to it and for at least 30 days from base_live_at, so the setting can
-- be turned off again; creates then come from it as before. base_live_at is set when a base first replaces a build that
-- installs repositories, never from history.
ALTER TABLE cloud_v2_computers ADD COLUMN legacy_build_id uuid REFERENCES cloud_v2_computer_builds(id),
  ADD COLUMN base_live_at timestamptz;

-- A project that asked for its first copy while its organization had no base yet: queued when the base goes live.
ALTER TABLE cloud_projects ADD COLUMN copy_requested_at timestamptz;
CREATE INDEX cloud_projects_copy_requested ON cloud_projects (org_id) WHERE copy_requested_at IS NOT NULL;

-- A workspace created while its organization's base was being prepared: it waits for that base, and its document says
-- so ("Preparing the Cloud Computer…"). Cleared when the base is live.
ALTER TABLE cloud_v2_workspaces ADD COLUMN waiting_for_base_at timestamptz,
  -- When the lifecycle saw that base live: the boot deadline counts from it on every later tick, not from the create.
  ADD COLUMN base_ready_at timestamptz;
