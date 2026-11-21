-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Where a failed ready copy went wrong, for the admin who must fix it: today
-- only the path of a file a setup left a build secret in. Never a value or a
-- line of file content; the builder withholds a path that contains a secret.
-- Down path: ALTER TABLE cloud_v2_ready_copies DROP COLUMN failure_detail;
ALTER TABLE cloud_v2_ready_copies
  ADD COLUMN failure_detail text CHECK (failure_detail IS NULL OR char_length(failure_detail) BETWEEN 1 AND 1100);
