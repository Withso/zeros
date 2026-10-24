-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_v2_workspaces
  ADD COLUMN stopped_at timestamptz,
  ADD COLUMN lease_renewed_at timestamptz,
  -- The base branch's remote head when the workspace was created. The worker
  -- branches from it when the Cloud Computer already has that commit.
  ADD COLUMN base_commit text CHECK (base_commit IS NULL OR base_commit ~ '^[0-9a-f]{40}$'),
  -- The last confirmed checkpoint: the workspace's own files, Git state and
  -- agent sessions, encrypted in object storage. Taken at every stop, kept
  -- until the workspace is deleted, and applied to a new VM when Boat has
  -- deleted the stopped one. The data key is sealed with the control plane's
  -- credential keys and bound to the workspace and object.
  ADD COLUMN checkpoint_object text
    CHECK (checkpoint_object IS NULL OR checkpoint_object ~ '^cloud-v2/checkpoints/[0-9a-f-]{36}/[0-9a-f-]{36}\.zck$'),
  ADD COLUMN checkpoint_key jsonb CHECK (checkpoint_key IS NULL OR jsonb_typeof(checkpoint_key) = 'object'),
  ADD COLUMN checkpoint_sha256 text CHECK (checkpoint_sha256 IS NULL OR checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN checkpoint_bytes bigint CHECK (checkpoint_bytes IS NULL OR checkpoint_bytes > 0),
  ADD COLUMN checkpoint_saved_at timestamptz,
  -- Why the latest stop could not save a checkpoint; the previous one is kept.
  ADD COLUMN checkpoint_error text CHECK (checkpoint_error IS NULL OR checkpoint_error ~ '^[a-z0-9_]{1,64}$'),
  -- boat_sandbox_id names a replacement VM that has not had the checkpoint
  -- applied yet. Wake retries the apply; deletion removes the replacement.
  ADD COLUMN restore_pending boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT cloud_v2_checkpoint_complete CHECK (
    (checkpoint_object IS NULL) = (checkpoint_key IS NULL) AND
    (checkpoint_object IS NULL) = (checkpoint_sha256 IS NULL) AND
    (checkpoint_object IS NULL) = (checkpoint_bytes IS NULL) AND
    (checkpoint_object IS NULL) = (checkpoint_saved_at IS NULL)),
  ADD CONSTRAINT cloud_v2_restore_requires_checkpoint CHECK (NOT restore_pending OR checkpoint_object IS NOT NULL);

UPDATE cloud_v2_workspaces SET stopped_at = updated_at WHERE state = 'stopped';

CREATE INDEX cloud_v2_lease_due ON cloud_v2_workspaces (lease_renewed_at)
  WHERE state = 'running' AND boat_sandbox_id IS NOT NULL;
