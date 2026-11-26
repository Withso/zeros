-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- An empty-slot PAT removal fences pending PAT validations independently of App OAuth.
CREATE TABLE cloud_github_pat_removals (
  org_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (org_id, owner_user_id),
  FOREIGN KEY (org_id, owner_user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE
);
ALTER TABLE cloud_github_pat_removals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_github_pat_removals FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_github_pat_removals USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE ON cloud_github_pat_removals TO zeros_app;
