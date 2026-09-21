-- Device identity is additive for historical SSH clients. Portable admission
-- requires it in the service; unbound legacy grants never gain device trust.
ALTER TABLE cloud_workspace_endpoint_grants
  ADD COLUMN device_id uuid,
  ADD COLUMN device_key_version bigint,
  ADD CONSTRAINT cloud_workspace_endpoint_grants_device_binding_check CHECK (
    (device_id IS NULL AND device_key_version IS NULL)
    OR (device_id IS NOT NULL AND device_key_version IS NOT NULL
        AND device_key_version > 0 AND purpose = 'engine-connect')
  ),
  ADD CONSTRAINT cloud_workspace_endpoint_grants_device_owner_fkey
    FOREIGN KEY (device_id, account_user_id) REFERENCES devices(id, user_id) ON DELETE CASCADE;

CREATE INDEX cloud_workspace_endpoint_grants_device_idx
  ON cloud_workspace_endpoint_grants (device_id) WHERE device_id IS NOT NULL;

-- Platform describes a client, never an execution or trust boundary. The same
-- signed device protocol serves desktops, tablets, phones and browsers.
ALTER TABLE devices DROP CONSTRAINT devices_platform_check;
ALTER TABLE devices ADD CONSTRAINT devices_platform_check CHECK (
  platform IN ('macos', 'windows', 'linux', 'ios', 'ipados', 'android', 'web')
);
