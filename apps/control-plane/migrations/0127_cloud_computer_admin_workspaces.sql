-- zeros-migration: expand
-- D1 authors this sidecar in the same transaction as the first generation.
-- A workspace flag, file, prompt or environment variable grants no authority.
CREATE TABLE cloud_computer_admin_workspaces (
  workspace_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  creator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE RESTRICT
);
CREATE INDEX cloud_computer_admin_workspaces_creator
  ON cloud_computer_admin_workspaces(org_id,creator_user_id);
CREATE TRIGGER cloud_computer_admin_workspace_immutable
  BEFORE UPDATE OR DELETE ON cloud_computer_admin_workspaces
  FOR EACH ROW EXECUTE FUNCTION cloud_computer_v2_config_immutable();
ALTER TABLE cloud_computer_admin_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computer_admin_workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computer_admin_workspaces_system ON cloud_computer_admin_workspaces
  FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT ON cloud_computer_admin_workspaces TO zeros_app;
