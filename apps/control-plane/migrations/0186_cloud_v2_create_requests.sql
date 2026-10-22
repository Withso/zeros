-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Successful create receipts commit with the workspace, not with delivery of
-- its HTTP response. Keep them until the workspace's retained row is purged.
CREATE TABLE cloud_v2_create_requests (
  creator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key text NOT NULL CHECK (char_length(request_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  status integer NOT NULL CHECK (status = 201),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  PRIMARY KEY (creator_user_id, request_key)
);
CREATE INDEX cloud_v2_create_requests_workspace ON cloud_v2_create_requests (workspace_id);
ALTER TABLE cloud_v2_create_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_create_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_create_requests USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT ON cloud_v2_create_requests TO zeros_app;
