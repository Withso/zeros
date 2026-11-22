-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A repository after the first of a workspace of several reports its own
-- environment seeding, exactly as the first repository's pin does in
-- cloud_workspace_environment_pins (0218). A failure here marks only that
-- repository; the workspace's readiness stays the first repository's.
-- The table is unused before this release, so the columns are added nullable
-- with the same checks and no backfill.
--
-- Down path (never run automatically): ALTER TABLE cloud_workspace_environment_repository_pins
--   DROP CONSTRAINT cloud_workspace_environment_repository_pins_report,
--   DROP CONSTRAINT cloud_workspace_environment_repository_pins_outcome,
--   DROP CONSTRAINT cloud_workspace_environment_repository_pins_ready,
--   DROP COLUMN report_boot_id, DROP COLUMN report_sequence, DROP COLUMN report_state, DROP COLUMN report_error;

ALTER TABLE cloud_workspace_environment_repository_pins
  ADD COLUMN report_boot_id uuid,
  ADD COLUMN report_sequence bigint CHECK (report_sequence BETWEEN 1 AND 9007199254740991),
  ADD COLUMN report_state text CHECK (report_state IN ('ready','failed')),
  ADD COLUMN report_error text CHECK (report_error IN ('cloud_environment_path_conflict','cloud_environment_path_untracked_required',
    'cloud_environment_path_ignored_required','cloud_environment_seed_uncertain','cloud_environment_pin_changed','cloud_environment_runtime_required')),
  ADD CONSTRAINT cloud_workspace_environment_repository_pins_report
    CHECK ((report_boot_id IS NULL)=(report_sequence IS NULL) AND (report_boot_id IS NULL)=(report_state IS NULL)),
  ADD CONSTRAINT cloud_workspace_environment_repository_pins_outcome
    CHECK ((report_state='failed' AND report_error IS NOT NULL) OR (report_state='ready' AND report_error IS NULL) OR (report_state IS NULL AND report_error IS NULL)),
  ADD CONSTRAINT cloud_workspace_environment_repository_pins_ready
    CHECK (ready_boot_id IS NULL OR (report_state='ready' AND report_boot_id=ready_boot_id));

CREATE INDEX cloud_workspace_environment_repository_version ON cloud_workspace_environment_repository_pins(version_id);
