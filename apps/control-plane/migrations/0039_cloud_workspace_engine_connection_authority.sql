-- Endpoint capabilities issued before this migration cannot prove which
-- execution authority epoch minted them. Retire them rather than silently
-- blessing them with the workspace's current epoch.
ALTER TABLE cloud_workspace_endpoint_grants
  ADD COLUMN authority_epoch bigint,
  ADD COLUMN engine_instance_id uuid
    REFERENCES cloud_workspace_engine_instances(id) ON DELETE CASCADE;

UPDATE cloud_workspace_endpoint_grants
SET revoked_at = coalesce(revoked_at, now())
WHERE authority_epoch IS NULL;

ALTER TABLE cloud_workspace_endpoint_grants
  ADD CONSTRAINT cloud_workspace_endpoint_grants_authority_epoch_check
  CHECK (authority_epoch IS NULL OR authority_epoch > 0);

CREATE INDEX cloud_workspace_endpoint_grants_live_authority_idx
  ON cloud_workspace_endpoint_grants (
    workspace_id, generation, authority_epoch, purpose, expires_at
  )
  WHERE revoked_at IS NULL AND consumed_at IS NULL;

CREATE INDEX cloud_workspace_endpoint_grants_engine_instance_idx
  ON cloud_workspace_endpoint_grants (engine_instance_id)
  WHERE engine_instance_id IS NOT NULL;
