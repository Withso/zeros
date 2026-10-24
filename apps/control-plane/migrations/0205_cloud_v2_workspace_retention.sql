-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_v2_workspaces
  ADD COLUMN stopped_at timestamptz,
  ADD COLUMN retention_snapshot text CHECK (retention_snapshot IS NULL OR retention_snapshot ~ '^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$'),
  ADD COLUMN retention_saved_at timestamptz,
  ADD COLUMN lease_renewed_at timestamptz,
  -- Provider intent survives a process crash. Wake and erasure wait for the
  -- bounded save/create request before touching its source or named result.
  ADD COLUMN retention_operation_until timestamptz,
  ADD COLUMN restore_pending boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT cloud_v2_retention_saved_requires_name
    CHECK (retention_saved_at IS NULL OR retention_snapshot IS NOT NULL);

UPDATE cloud_v2_workspaces SET stopped_at = updated_at WHERE state = 'stopped';

CREATE UNIQUE INDEX cloud_v2_retention_snapshot_name ON cloud_v2_workspaces (retention_snapshot)
  WHERE retention_snapshot IS NOT NULL;
CREATE INDEX cloud_v2_retention_due ON cloud_v2_workspaces (stopped_at)
  WHERE state = 'stopped' AND retention_saved_at IS NULL;
CREATE INDEX cloud_v2_lease_due ON cloud_v2_workspaces (lease_renewed_at)
  WHERE state = 'running' AND boat_sandbox_id IS NOT NULL;
