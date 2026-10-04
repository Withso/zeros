-- zeros-migration: expand
-- The scalar remote_port remains display metadata for agent previews. Native
-- runtimes resolve this additive opaque identity inside the trusted engine.
ALTER TABLE cloud_workspace_client_access_grants
  ADD COLUMN preview_target jsonb,
  ADD COLUMN preview_device_id uuid REFERENCES devices(id),
  ADD COLUMN preview_device_key_version integer;

ALTER TABLE cloud_workspace_client_access_grants
  ADD CONSTRAINT cloud_access_preview_device_shape CHECK (
    (preview_device_id IS NULL AND preview_device_key_version IS NULL)
    OR (kind = 'preview' AND num_nonnulls(preview_device_id, preview_device_key_version) = 2
        AND preview_device_key_version > 0)
  );

ALTER TABLE cloud_workspace_client_access_grants
  ADD CONSTRAINT cloud_access_preview_target_shape CHECK (
    preview_target IS NULL OR (
      kind = 'preview' AND jsonb_typeof(preview_target) = 'object'
      AND preview_target ?& ARRAY['executionId', 'portId']
      AND (preview_target - 'executionId' - 'portId') = '{}'::jsonb
      AND jsonb_typeof(preview_target->'executionId') = 'string'
      AND jsonb_typeof(preview_target->'portId') = 'string'
      AND preview_target->>'executionId' ~ '^[A-Za-z0-9_-]{1,128}$'
      AND preview_target->>'portId' ~ '^[A-Za-z0-9_-]{32}$'
    )
  );
