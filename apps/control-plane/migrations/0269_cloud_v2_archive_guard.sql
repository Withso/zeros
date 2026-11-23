-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
-- The provider can report a failed snapshot attempt when a machine is stopped while one is in progress; a fork of that
-- machine then lacked the files written just before (src/cloud/boat-disk.ts).

-- What the provider said of a ready copy's archive when it was promoted: {attemptAt, status} of the stop's snapshot attempt,
-- so the next failure of this kind can be read from the database. NULL for a copy promoted before this.
ALTER TABLE cloud_v2_ready_copies ADD COLUMN archive_snapshot jsonb
  CHECK (archive_snapshot IS NULL OR jsonb_typeof(archive_snapshot) = 'object');

-- The stop generation during whose stop the provider reported a failed snapshot attempt: that stop's archive may lack its last
-- writes, so nothing may call it good (the retention probe reads it). NULL when no stop has.
ALTER TABLE cloud_v2_workspaces ADD COLUMN stop_archive_failed_generation bigint;
