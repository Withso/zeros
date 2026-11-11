-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_v2_workspaces ADD COLUMN setup_status jsonb;
ALTER TABLE cloud_v2_workspaces ADD CONSTRAINT cloud_v2_workspace_setup_status
  CHECK (setup_status IS NULL OR jsonb_typeof(setup_status) = 'object') NOT VALID;
