-- Human services terminate at the workload identity. Provider administration
-- credentials and legacy provider SSH grants never confer this authority.
CREATE TABLE cloud_workspace_runtime_service_grants (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  org_id uuid NOT NULL,
  account_user_id uuid NOT NULL,
  authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
  engine_instance_id uuid NOT NULL,
  provider_resource_id text NOT NULL CHECK (char_length(provider_resource_id) BETWEEN 1 AND 512),
  device_id uuid NOT NULL,
  device_key_version bigint NOT NULL CHECK (device_key_version > 0),
  kind text NOT NULL CHECK (kind IN ('ssh', 'tunnel')),
  remote_port integer,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (workspace_id, account_user_id, idempotency_key),
  FOREIGN KEY (workspace_id, org_id) REFERENCES cloud_workspaces(id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (engine_instance_id, workspace_id, generation, org_id)
    REFERENCES cloud_workspace_engine_instances(id, workspace_id, generation, org_id) ON DELETE CASCADE,
  FOREIGN KEY (device_id, account_user_id) REFERENCES devices(id, user_id) ON DELETE CASCADE,
  CHECK ((kind = 'ssh' AND remote_port IS NULL) OR
         (kind = 'tunnel' AND remote_port BETWEEN 1024 AND 65535 AND remote_port <> 22222)),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes')
);
CREATE INDEX cloud_runtime_services_workspace ON cloud_workspace_runtime_service_grants(workspace_id, generation, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX cloud_runtime_services_device ON cloud_workspace_runtime_service_grants(device_id);
ALTER TABLE cloud_workspace_runtime_service_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_runtime_service_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_runtime_services_system ON cloud_workspace_runtime_service_grants
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_workspace_runtime_service_grants TO zeros_app;
