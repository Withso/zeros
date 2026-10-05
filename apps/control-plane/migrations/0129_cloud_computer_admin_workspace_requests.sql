-- zeros-migration: expand
-- Reopen receipts must survive activation without creating another allocation.
CREATE TABLE cloud_computer_admin_workspace_requests (
  org_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  creator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expected_active_version bigint NOT NULL CHECK (expected_active_version > 0),
  workspace_id uuid NOT NULL REFERENCES cloud_computer_admin_workspaces(workspace_id) ON DELETE RESTRICT,
  intent_id uuid NOT NULL REFERENCES cloud_workspace_lifecycle_intents(id) ON DELETE RESTRICT,
  reused boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, operation_id),
  FOREIGN KEY (workspace_id, org_id) REFERENCES cloud_workspaces(id, org_id) ON DELETE RESTRICT
);
CREATE INDEX cloud_computer_admin_workspace_requests_workspace
  ON cloud_computer_admin_workspace_requests(workspace_id, created_at);
CREATE TRIGGER cloud_computer_admin_workspace_request_immutable
  BEFORE UPDATE OR DELETE ON cloud_computer_admin_workspace_requests
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_config_immutable();
ALTER TABLE cloud_computer_admin_workspace_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computer_admin_workspace_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computer_admin_workspace_requests_system ON cloud_computer_admin_workspace_requests
  FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT, INSERT ON cloud_computer_admin_workspace_requests TO zeros_app;
