-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
-- Zeros's shared standard base (src/cloud/shared-base.ts): one Boat named snapshot per worker runtime holding the
-- runtime and Git LFS and nothing private, the base of every organization without an install script. The builder
-- makes it on its own tick for the channel's pinned runtime; each row is written before its snapshot is saved, so no
-- name the control plane saves goes unrecorded. The current base is the newest ready row (CLOUD_V2_SHARED_BASE_SNAPSHOT
-- may still pin a name or turn it off). Nothing outside shared-base.ts reads this table yet.
--
-- Down path (never run automatically): DROP TABLE cloud_v2_shared_bases;
CREATE TABLE cloud_v2_shared_bases (
  name text PRIMARY KEY CHECK (name ~ '^zeros-(alpha|production|development|local-[a-f0-9]{24})-base-[0-9a-f]{12}(-r[1-9][0-9]{0,2})?$'),
  channel text NOT NULL CHECK (channel IN ('alpha','production','development')),
  runtime_sha256 text NOT NULL CHECK (runtime_sha256 ~ '^[0-9a-f]{64}$'),
  -- 0 for the runtime's first attempt; each retry after a failure, or rebuild after Boat lost it, takes the next.
  rebuild integer NOT NULL DEFAULT 0 CHECK (rebuild BETWEEN 0 AND 999),
  state text NOT NULL CHECK (state IN ('building','ready','failed','deleted')),
  -- The builder's Boat idempotency key and sandbox name, as Cloud Computer builds use theirs.
  build_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  builder_sandbox_id text CHECK (builder_sandbox_id IS NULL OR char_length(builder_sandbox_id) BETWEEN 1 AND 128),
  builder_create_pending boolean NOT NULL DEFAULT false,
  builder_deleted_at timestamptz,
  heartbeat_at timestamptz,
  -- The save was asked for: Boat may hold the name even when the build failed, until it is confirmed deleted.
  save_requested_at timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'),
  -- Consecutive failures for this runtime, this one included, and when the next attempt may start.
  failures integer NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 1000),
  next_attempt_at timestamptz,
  -- Interruptions in a row (a deploy stopped its builder): up to three retry at once, without counting as failures.
  interruptions integer NOT NULL DEFAULT 0 CHECK (interruptions BETWEEN 0 AND 1000),
  -- The missing-base sweep's first reading of Boat answering 404 for it; a second scan in a row acts, a present one clears it.
  missing_seen_at timestamptz,
  -- The missing-base sweep found Boat no longer has it.
  missing_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ready_at timestamptz,
  finished_at timestamptz,
  -- No longer current; deletion waits at least 6 hours from here and for every reference to end.
  superseded_at timestamptz,
  deleted_at timestamptz,
  CHECK (state <> 'ready' OR ready_at IS NOT NULL),
  CHECK (state <> 'deleted' OR deleted_at IS NOT NULL)
);
-- The current ready base per channel and runtime, and the one-build-per-runtime check.
CREATE INDEX cloud_v2_shared_bases_ready ON cloud_v2_shared_bases (channel, runtime_sha256, ready_at DESC) WHERE state = 'ready';
CREATE INDEX cloud_v2_shared_bases_building ON cloud_v2_shared_bases (channel, runtime_sha256) WHERE state = 'building';
-- Deletion candidates: superseded and not yet deleted.
CREATE INDEX cloud_v2_shared_bases_superseded ON cloud_v2_shared_bases (superseded_at) WHERE superseded_at IS NOT NULL AND deleted_at IS NULL;
-- Builders still to remove, and saves still to confirm gone.
CREATE INDEX cloud_v2_shared_bases_cleanup ON cloud_v2_shared_bases (created_at)
  WHERE state <> 'building' AND ((builder_sandbox_id IS NOT NULL AND builder_deleted_at IS NULL) OR builder_create_pending
    OR (state = 'failed' AND save_requested_at IS NOT NULL AND deleted_at IS NULL));
ALTER TABLE cloud_v2_shared_bases ENABLE ROW LEVEL SECURITY;
CREATE POLICY cloud_v2_shared_bases_system ON cloud_v2_shared_bases FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
