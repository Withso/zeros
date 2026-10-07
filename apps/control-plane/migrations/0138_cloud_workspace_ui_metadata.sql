-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A supplied empty scan has no workspace_ports rows. NULL means that this
-- generation has not confirmed a scan; ordinary heartbeats do not change it.
ALTER TABLE cloud_workspace_generations ADD COLUMN ports_observed_at timestamptz;

-- Metadata retries never enqueue lifecycle work or require an engine action.
-- Only the normalized request hash is retained, not the authored name.
CREATE TABLE cloud_workspace_metadata_requests (
  org_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 128
    AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  workspace_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256)=32),
  result_version bigint NOT NULL CHECK (result_version BETWEEN 0 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id,idempotency_key),
  FOREIGN KEY (workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE
);
CREATE INDEX cloud_workspace_metadata_requests_workspace ON cloud_workspace_metadata_requests(workspace_id);
ALTER TABLE cloud_workspace_metadata_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_metadata_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY system_read ON cloud_workspace_metadata_requests FOR SELECT USING(app_is_system());
CREATE POLICY system_insert ON cloud_workspace_metadata_requests FOR INSERT WITH CHECK(app_is_system());
GRANT SELECT,INSERT ON cloud_workspace_metadata_requests TO zeros_app;
