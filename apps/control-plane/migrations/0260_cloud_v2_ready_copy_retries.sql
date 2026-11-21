-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- What a ready copy generation was built from: the base build, the
-- repository's setup and branch, its build secrets' revision, or a private
-- entry. Failed generations with the same inputs count toward the retry
-- backoff; a change to any of them starts it over.
-- Down path: ALTER TABLE cloud_v2_ready_copies DROP COLUMN inputs, DROP COLUMN manual_retry;
ALTER TABLE cloud_v2_ready_copies
  ADD COLUMN inputs text CHECK (inputs IS NULL OR inputs ~ '^[0-9a-f]{64}$'),
  ADD COLUMN manual_retry boolean NOT NULL DEFAULT false;
