-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
-- Retention S4 (CLOUD_V2_RETENTION_ENABLED, src/cloud/lifecycle.ts): an archived workspace's backup is removed at
-- greatest(archived_at, retention_started_at) + 60 days (CLOUD_V2_BACKUP_REMOVAL_AT_SQL), in two phases. One statement
-- clears the row's backup (object, sealed key, digest) and records the object here; then its objects are deleted
-- and the record marked done. Between the two there is an object with no key (unreadable, and recorded for
-- deletion), never a key without an object.
CREATE TABLE cloud_v2_backup_removals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  object text NOT NULL CHECK (char_length(object) BETWEEN 1 AND 512),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  done_at timestamptz
);
CREATE INDEX cloud_v2_backup_removals_pending ON cloud_v2_backup_removals (requested_at) WHERE done_at IS NULL;
ALTER TABLE cloud_v2_backup_removals ENABLE ROW LEVEL SECURITY;
CREATE POLICY cloud_v2_backup_removals_system ON cloud_v2_backup_removals FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

-- A missed wake (a sleeping machine 12 days past its last stop) is alerted once per stop.
ALTER TABLE cloud_v2_workspaces ADD COLUMN missed_wake_alerted_at timestamptz;

-- A personal project whose member left: its build secrets are deleted and its copy retired at once; the project
-- waits, theirs again if they are re-added, and is deleted 60 days after the later of this stamp and retention's
-- first look at it (retention_started_at, set by the lane; no clock starts from history).
ALTER TABLE cloud_projects ADD COLUMN owner_left_at timestamptz, ADD COLUMN retention_started_at timestamptz;
CREATE INDEX cloud_projects_owner_left ON cloud_projects (owner_left_at) WHERE owner_left_at IS NOT NULL;

-- 0263's membership triggers, extended: the departure also deletes that member's personal projects' build secrets in
-- the organization and stamps those projects; the return clears the stamp. Still one bounded statement each that
-- never waits for a held row (SKIP LOCKED) and never fails the membership write; the lifecycle sweeps what it skips.
-- zeros-expand-exception: departed-private-projects Extends the departure trigger to delete the departed member's personal build secrets and stamp their projects
CREATE OR REPLACE FUNCTION cloud_v2_archive_departed_private() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous_system text := current_setting('app.system',true);
BEGIN
  PERFORM set_config('app.system','on',true);
  BEGIN
    UPDATE public.cloud_v2_workspaces w SET archived_at = clock_timestamp(), archive_reason = 'member_left', keep_set_at = NULL, keep_set_by = NULL
      WHERE w.id IN (SELECT c.id FROM public.cloud_v2_workspaces c
        WHERE c.org_id = OLD.org_id AND c.private_owner_user_id = OLD.user_id AND c.state NOT IN ('deleting', 'deleted')
          AND c.archived_at IS NULL
        FOR UPDATE SKIP LOCKED);
    DELETE FROM public.cloud_v2_ready_copy_secrets s
      WHERE s.project_id IN (SELECT q.project_id FROM public.cloud_v2_ready_copy_secrets q JOIN public.cloud_projects p ON p.id = q.project_id
        WHERE p.org_id = OLD.org_id AND p.level = 'personal' AND p.owner_user_id = OLD.user_id
        FOR UPDATE OF q SKIP LOCKED);
    UPDATE public.cloud_projects p SET owner_left_at = coalesce(p.owner_left_at, clock_timestamp())
      WHERE p.id IN (SELECT q.id FROM public.cloud_projects q
        WHERE q.org_id = OLD.org_id AND q.level = 'personal' AND q.owner_user_id = OLD.user_id
        FOR UPDATE SKIP LOCKED);
  EXCEPTION WHEN OTHERS THEN NULL; -- Never fails the removal: the lifecycle's sweep does what this skipped.
  END;
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: returning-private-projects Extends the return trigger to clear the stamp on the returning member's own personal projects
CREATE OR REPLACE FUNCTION cloud_v2_restore_returning_private() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous_system text := current_setting('app.system',true);
  previous_ownership text := current_setting('app.cloud_team_ownership',true);
BEGIN
  PERFORM set_config('app.system','on',true);
  PERFORM set_config('app.cloud_team_ownership','1',true);
  BEGIN
    UPDATE public.cloud_v2_workspaces w SET creator_user_id = NEW.user_id
      WHERE w.id IN (SELECT c.id FROM public.cloud_v2_workspaces c
        WHERE c.org_id = NEW.org_id AND c.private_owner_user_id = NEW.user_id AND c.creator_user_id IS NULL
          AND c.creator_absent_reason = 'left' AND c.state NOT IN ('deleting', 'deleted')
          AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.user_id AND u.auth_status = 'active' AND u.deleted_at IS NULL)
          AND NOT public.organization_member_on_hold(NEW.org_id, NEW.user_id, 10, 5)
        FOR UPDATE SKIP LOCKED);
    UPDATE public.cloud_projects p SET owner_left_at = NULL, retention_started_at = NULL
      WHERE p.id IN (SELECT q.id FROM public.cloud_projects q
        WHERE q.org_id = NEW.org_id AND q.level = 'personal' AND q.owner_user_id = NEW.user_id AND q.owner_left_at IS NOT NULL
        FOR UPDATE SKIP LOCKED);
  EXCEPTION WHEN OTHERS THEN NULL; -- Never fails the membership: the lifecycle's sweep does what this skipped.
  END;
  PERFORM set_config('app.cloud_team_ownership',coalesce(previous_ownership,''),true);
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
  RETURN NULL;
END;
$$;

-- A GitHub connection removed: every ready copy of a project with a repository on it is retired, and the project is
-- recorded, before the foreign key clears the reference (after which a NULL connection says nothing: many are NULL
-- from the start). A copy's machine holds that repository's clone; the copy builder's cleanup deletes it. The trigger
-- never waits for a copy another transaction holds (SKIP LOCKED) and never fails the removal; the lifecycle retires
-- what it skipped from the record, then clears it. The next workspace opened from the project queues a new copy.
CREATE TABLE cloud_v2_disconnected_projects (
  project_id uuid PRIMARY KEY REFERENCES cloud_projects(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE cloud_v2_disconnected_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY cloud_v2_disconnected_projects_system ON cloud_v2_disconnected_projects FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE FUNCTION cloud_v2_retire_disconnected_copies() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous_system text := current_setting('app.system',true);
BEGIN
  PERFORM set_config('app.system','on',true);
  BEGIN
    INSERT INTO public.cloud_v2_disconnected_projects (project_id)
      SELECT DISTINCT r.project_id FROM public.cloud_project_repositories r WHERE r.connection = OLD.id
      ON CONFLICT (project_id) DO NOTHING;
    UPDATE public.cloud_v2_ready_copies SET state = CASE WHEN state = 'building' THEN 'failed' ELSE 'retired' END,
        failure_reason = CASE WHEN state = 'building' THEN 'connection_removed' ELSE failure_reason END, updated_at = clock_timestamp()
      WHERE id IN (SELECT c.id FROM public.cloud_v2_ready_copies c
        WHERE c.state IN ('building', 'ready') AND EXISTS (SELECT 1 FROM public.cloud_project_repositories r
          WHERE r.project_id = c.project_id AND r.connection = OLD.id)
        ORDER BY c.id FOR UPDATE SKIP LOCKED);
  EXCEPTION WHEN OTHERS THEN NULL; -- Never fails the removal: the recorded projects' copies are retired by the lifecycle.
  END;
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
  RETURN OLD;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new connection-removal trigger function
REVOKE ALL ON FUNCTION cloud_v2_retire_disconnected_copies() FROM PUBLIC;
CREATE TRIGGER cloud_v2_connection_removed BEFORE DELETE ON cloud_github_installations
  FOR EACH ROW EXECUTE FUNCTION cloud_v2_retire_disconnected_copies();
