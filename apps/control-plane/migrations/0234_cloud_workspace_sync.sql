-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_v2_connected_macs ADD COLUMN syncing boolean NOT NULL DEFAULT false;
ALTER TABLE cloud_v2_workspaces ADD COLUMN sync_boot_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]
  CHECK (cardinality(sync_boot_ids) <= 2);
