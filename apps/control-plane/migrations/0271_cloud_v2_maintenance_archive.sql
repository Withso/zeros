-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
-- When a maintenance wake's stop (which keeps the person's stop generation) left the machine's archive suspect: a
-- snapshot attempt reported failed, or one that began before the stop itself (src/cloud/boat-disk.ts). Kept apart from
-- stop_archive_failed_generation, whose stop and backup it says nothing about. NULL when none has.
ALTER TABLE cloud_v2_workspaces ADD COLUMN maintenance_archive_suspect_at timestamptz;
-- When a backup fork last found the archive unchanged since the checkpoint it holds (checkpointUnchanged): that checkpoint
-- then covers this stop though it was saved before it. Cleared by every new checkpoint. NULL when none has.
ALTER TABLE cloud_v2_workspaces ADD COLUMN checkpoint_confirmed_at timestamptz;
