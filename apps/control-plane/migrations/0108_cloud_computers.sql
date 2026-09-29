-- Organization-owned setup recipes and real, disposable validation runs.
-- Recipes are immutable environment versions; activation affects new workspaces.
CREATE TABLE cloud_computers (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  draft_version bigint NOT NULL CHECK(draft_version>0),
  active_version bigint,
  operation_id uuid NOT NULL,
  request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(profile_id,org_id) REFERENCES environment_profiles(id,org_id) ON DELETE CASCADE,
  FOREIGN KEY(profile_id,draft_version,org_id) REFERENCES environment_profile_versions(profile_id,version,org_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(profile_id,active_version,org_id) REFERENCES environment_profile_versions(profile_id,version,org_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE cloud_computer_builds (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES cloud_computers(org_id) ON DELETE CASCADE,
  profile_id uuid NOT NULL,
  version bigint NOT NULL,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  workspace_id uuid UNIQUE,
  repository_owner text NOT NULL,
  repository_name text NOT NULL,
  state text NOT NULL DEFAULT 'building' CHECK(state IN ('building','succeeded','failed','cancelled')),
  cleanup_state text NOT NULL DEFAULT 'pending' CHECK(cleanup_state IN ('pending','requested','complete')),
  log_excerpt text NOT NULL DEFAULT '' CHECK(octet_length(log_excerpt)<=262144),
  error_code text,
  deadline_at timestamptz NOT NULL DEFAULT (now()+interval '30 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY(profile_id,version,org_id) REFERENCES environment_profile_versions(profile_id,version,org_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE SET NULL(workspace_id)
);
CREATE UNIQUE INDEX cloud_computer_one_active_build ON cloud_computer_builds(org_id) WHERE state='building';
CREATE INDEX cloud_computer_cleanup ON cloud_computer_builds(last_checked_at,id) WHERE state='building' OR cleanup_state<>'complete';
ALTER TABLE cloud_computers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computers FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computers_system ON cloud_computers FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_computer_builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_computer_builds FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_computer_builds_system ON cloud_computer_builds FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_computers,cloud_computer_builds TO zeros_app;
