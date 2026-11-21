-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A repository's ready copy history. Why each generation ran is stored when it
-- is queued, never inferred later. A failed setup keeps the last part of its
-- output, with every build secret redacted; successful generations keep none.
-- Beyond the history bound a generation's detail (output, location) is
-- cleared; its row, and its machine's cleanup, stay.
-- Down path: ALTER TABLE cloud_v2_ready_copies DROP COLUMN trigger, DROP COLUMN triggered_by,
--   DROP COLUMN setup_output, DROP COLUMN detail_pruned_at;
ALTER TABLE cloud_v2_ready_copies
  ADD COLUMN trigger text CHECK (trigger IS NULL OR trigger IN ('repository_added','weekly_update','computer_build','setup_changed',
    'branch_changed','secrets_changed','retry','manual')),
  ADD COLUMN triggered_by uuid,
  ADD COLUMN setup_output text CHECK (setup_output IS NULL OR octet_length(setup_output) <= 16384),
  ADD COLUMN detail_pruned_at timestamptz;
