-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

CREATE TABLE cloud_environment_versions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id bigint NOT NULL CHECK (repository_id BETWEEN 1 AND 9007199254740991),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id,owner_user_id,repository_id,id)
);
CREATE TABLE cloud_environment_heads (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id bigint NOT NULL CHECK (repository_id BETWEEN 1 AND 9007199254740991),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  version_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id,owner_user_id,repository_id),
  FOREIGN KEY (org_id,owner_user_id,repository_id,version_id)
    REFERENCES cloud_environment_versions(org_id,owner_user_id,repository_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE cloud_workspace_environment_pins (
  workspace_id uuid PRIMARY KEY REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id bigint NOT NULL CHECK (repository_id BETWEEN 1 AND 9007199254740991),
  version_id uuid NOT NULL,
  ready_boot_id uuid,
  report_boot_id uuid,
  report_sequence bigint CHECK (report_sequence BETWEEN 1 AND 9007199254740991),
  report_state text CHECK (report_state IN ('ready','failed')),
  report_error text CHECK (report_error IN ('cloud_environment_path_conflict','cloud_environment_path_untracked_required',
    'cloud_environment_path_ignored_required','cloud_environment_seed_uncertain','cloud_environment_pin_changed','cloud_environment_runtime_required')),
  FOREIGN KEY (org_id,owner_user_id,repository_id,version_id)
    REFERENCES cloud_environment_versions(org_id,owner_user_id,repository_id,id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((report_boot_id IS NULL)=(report_sequence IS NULL) AND (report_boot_id IS NULL)=(report_state IS NULL)),
  CHECK ((report_state='failed' AND report_error IS NOT NULL) OR (report_state='ready' AND report_error IS NULL) OR (report_state IS NULL AND report_error IS NULL)),
  CHECK (ready_boot_id IS NULL OR (report_state='ready' AND report_boot_id=ready_boot_id))
);
CREATE INDEX cloud_workspace_environment_version ON cloud_workspace_environment_pins(version_id);
CREATE INDEX cloud_environment_head_version ON cloud_environment_heads(version_id) WHERE version_id IS NOT NULL;

ALTER TABLE cloud_environment_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_environment_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_environment_versions USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_environment_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_environment_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_environment_heads USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_workspace_environment_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_environment_pins FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_workspace_environment_pins USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_environment_versions,cloud_environment_heads,cloud_workspace_environment_pins TO zeros_app;

-- An older hello writer cannot silently omit a persisted environment pin.
-- Unpinned historical workspaces retain the preceding readiness contract.
CREATE FUNCTION cloud_environment_ready_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state='running' AND EXISTS (SELECT 1 FROM public.cloud_workspace_environment_pins p
    WHERE p.workspace_id=NEW.id AND (p.ready_boot_id IS NULL OR NEW.worker_boot_id IS NULL OR p.ready_boot_id IS DISTINCT FROM NEW.worker_boot_id)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='cloud_environment_not_ready', CONSTRAINT='cloud_environment_ready';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_environment_ready BEFORE UPDATE OF state,worker_boot_id ON cloud_v2_workspaces
  FOR EACH ROW EXECUTE FUNCTION cloud_environment_ready_guard();
