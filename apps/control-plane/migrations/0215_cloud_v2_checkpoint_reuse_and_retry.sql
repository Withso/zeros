-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_v2_workspaces
  -- What the current checkpoint is compared by at the next stop, bound to that
  -- exact object: the fingerprint of everything it holds and the base commit
  -- whose objects it left out. A stop that finds the workspace unchanged keeps
  -- the object instead of uploading a copy. Any other object makes it stale.
  ADD COLUMN checkpoint_reuse jsonb CHECK (checkpoint_reuse IS NULL OR jsonb_typeof(checkpoint_reuse) = 'object'),
  -- When the latest stop finished.
  ADD COLUMN stopped_at timestamptz,
  -- A stop whose checkpoint failed is retried on a fork of the stopped VM
  -- until shortly before Boat deletes that VM's disk. The retry belongs to one
  -- stop; a newer stop starts over. The fork in flight is recorded before it
  -- is requested, so cleanup and deletion can always find it.
  ADD COLUMN checkpoint_retry_generation bigint,
  ADD COLUMN checkpoint_retry_at timestamptz,
  ADD COLUMN checkpoint_retry_attempts integer NOT NULL DEFAULT 0 CHECK (checkpoint_retry_attempts >= 0),
  ADD COLUMN checkpoint_retry_fork jsonb CHECK (checkpoint_retry_fork IS NULL OR jsonb_typeof(checkpoint_retry_fork) = 'object'),
  ADD COLUMN checkpoint_retry_exhausted_at timestamptz;

CREATE INDEX cloud_v2_checkpoint_retry_due ON cloud_v2_workspaces (stop_generation)
  WHERE state = 'stopped' AND checkpoint_stop_generation IS DISTINCT FROM stop_generation;
CREATE INDEX cloud_v2_checkpoint_retry_fork ON cloud_v2_workspaces (checkpoint_retry_at)
  WHERE checkpoint_retry_fork IS NOT NULL;
