-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Keep intent and provider confirmation until organization erasure can safely
-- cascade these rows. Existing resource IDs are re-deleted idempotently.
ALTER TABLE cloud_v2_computer_builds
  ADD COLUMN cleanup_requested_at timestamptz,
  ADD COLUMN builder_create_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN builder_deleted_at timestamptz,
  ADD COLUMN snapshot_deleted_at timestamptz,
  ADD COLUMN operation_until timestamptz;
