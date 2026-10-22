-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Route credentials are envelope-encrypted using the existing versioned vault
-- keyring. They never appear in workspace documents or token-bearing URLs.
ALTER TABLE cloud_v2_workspaces
  ADD COLUMN worker_route_url text,
  ADD COLUMN worker_port_token jsonb,
  ADD COLUMN worker_boot_id uuid,
  ADD COLUMN worker_history_sequence bigint NOT NULL DEFAULT 0,
  ADD COLUMN worker_history_digest text;
