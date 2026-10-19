-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- NULL preserves the conservative attempt-based cadence of legacy workers
-- and rows. Only an accepted successful create/wake dispatch initializes this
-- counter; it never resets the original dispatched_at or any error deadline.
ALTER TABLE cloud_workspace_lifecycle_intents ADD COLUMN healthy_observation_count smallint
  CHECK (healthy_observation_count IS NULL OR
    (operation IN ('create','wake') AND healthy_observation_count BETWEEN 1 AND 3));
