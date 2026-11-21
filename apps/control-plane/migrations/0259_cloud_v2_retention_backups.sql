-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
-- Retention (CLOUD_V2_RETENTION_ENABLED, src/cloud/lifecycle.ts): a stop no longer uploads a checkpoint. It runs a
-- read-only probe; about an hour later a backup is taken on a fork of the stopped VM only when that probe found work
-- not on GitHub, or could not tell.
-- retention_started_at: the first time retention applied to this workspace. Every retention clock starts here, never
-- from history.
-- backup_probe: what the probe of stop backup_probe_generation reported; another stop's answer never applies.
-- backup_forked_at: the last backup fork's request, for the hourly fork cap.
ALTER TABLE cloud_v2_workspaces
  ADD COLUMN retention_started_at timestamptz,
  ADD COLUMN backup_probe text CHECK (backup_probe IN ('clean', 'dirty', 'unknown')),
  ADD COLUMN backup_probe_generation bigint,
  ADD COLUMN backup_forked_at timestamptz;
CREATE INDEX cloud_v2_workspaces_backup_forked ON cloud_v2_workspaces (backup_forked_at) WHERE backup_forked_at IS NOT NULL;
