-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
-- Retention S3 (CLOUD_V2_RETENTION_ENABLED, src/cloud/lifecycle.ts): activity, Keep and archive.
-- person_activity_at: a person's own call on the workspace that does not already stamp active_at (connect, start,
-- chat edit, pull request, Keep, team management, the public API's writes). The retention clock is the latest of
-- active_at, person_activity_at and retention_started_at; active_at keeps its meaning for the idle stop.
-- keep_set_at/keep_set_by: Keep, set by anyone who can use the workspace; it exempts it from automatic archive and
-- from backup removal.
-- archive_reason: why archived_at is set ('manual', 'inactive', 'member_left'); shown only while archived.
-- changed_since_stop_at/_generation: a maintenance wake found a file under a checkout newer than the stop's
-- marker, so the stop's backup or clean probe no longer describes the machine.
-- archive_scrub/_at/_generation: the archived wake removed logins and environment values from the machine.
-- 'backup': the checkout's environment files too, which a settled backup holds; an open restores them from it
-- before the worker starts. 'clean': nothing an open must restore (none listed, or a re-seed writes them back
-- exactly). 'partial': environment files kept, having no other copy. The archive's final backup is settled
-- (taken, not needed, or retries exhausted) by rule, not by a column; the scrub waits for it, bounded.
ALTER TABLE cloud_v2_workspaces
  ADD COLUMN person_activity_at timestamptz,
  ADD COLUMN keep_set_at timestamptz,
  ADD COLUMN keep_set_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN archive_reason text CHECK (archive_reason IN ('manual', 'inactive', 'member_left')),
  ADD COLUMN changed_since_stop_at timestamptz,
  ADD COLUMN changed_since_stop_generation bigint,
  ADD COLUMN archive_scrub text CHECK (archive_scrub IN ('backup', 'clean', 'partial')),
  ADD COLUMN archive_scrubbed_at timestamptz,
  ADD COLUMN archive_scrubbed_generation bigint,
  -- Boat's dataExpiredAt for the machine, when a maintenance wake's inspect reported one.
  ADD COLUMN machine_data_expired_at timestamptz,
  ADD CONSTRAINT cloud_v2_archive_scrub_complete CHECK ((archive_scrub IS NULL) = (archive_scrubbed_at IS NULL));
-- The automatic-archive scan: sleeping, unarchived, not kept.
CREATE INDEX cloud_v2_workspaces_archive_scan ON cloud_v2_workspaces (org_id)
  WHERE archived_at IS NULL AND keep_set_at IS NULL AND state IN ('stopped', 'failed');
ALTER TABLE cloud_v2_maintenance_wakes
  ADD COLUMN changed_since_stop boolean,
  ADD COLUMN scrub text CHECK (scrub IN ('backup', 'clean', 'partial'));

-- A member who leaves: their personal projects' workspaces in that organization are archived at once, whatever
-- the retention switch says. One bounded statement that never waits for a row another transaction holds (SKIP
-- LOCKED), so a removal can never fail or queue behind the lifecycle; the lifecycle sweeps the same condition and
-- archives anything skipped, and stops a running one through the ordinary archive path. Nobody else gains access:
-- private_owner_user_id still admits only its member.
CREATE FUNCTION cloud_v2_archive_departed_private() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous_system text := current_setting('app.system',true);
BEGIN
  PERFORM set_config('app.system','on',true);
  BEGIN
    UPDATE public.cloud_v2_workspaces w SET archived_at = clock_timestamp(), archive_reason = 'member_left'
      WHERE w.id IN (SELECT c.id FROM public.cloud_v2_workspaces c
        WHERE c.org_id = OLD.org_id AND c.private_owner_user_id = OLD.user_id AND c.state NOT IN ('deleting', 'deleted')
          AND c.archived_at IS NULL
        FOR UPDATE SKIP LOCKED);
  EXCEPTION WHEN OTHERS THEN NULL; -- Never fails the removal: the lifecycle's sweep archives what this skipped.
  END;
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new retention trigger functions
REVOKE ALL ON FUNCTION cloud_v2_archive_departed_private() FROM PUBLIC;
CREATE TRIGGER cloud_v2_private_member_left AFTER DELETE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION cloud_v2_archive_departed_private();

-- The same member re-added: their private workspaces are theirs again (still archived; opening one works). Only
-- rows whose private owner is the person who joined, in that organization, and only the creator that
-- cloud_creator_member_loss cleared when they left.
CREATE FUNCTION cloud_v2_restore_returning_private() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous_system text := current_setting('app.system',true);
  previous_ownership text := current_setting('app.cloud_team_ownership',true);
BEGIN
  PERFORM set_config('app.system','on',true);
  -- A creator is cleared on departure only under the team-ownership switch (0246); restoring the same member
  -- uses it too, and guard_cloud_creator_ownership still checks they are eligible.
  PERFORM set_config('app.cloud_team_ownership','1',true);
  BEGIN
    UPDATE public.cloud_v2_workspaces w SET creator_user_id = NEW.user_id
      WHERE w.id IN (SELECT c.id FROM public.cloud_v2_workspaces c
        WHERE c.org_id = NEW.org_id AND c.private_owner_user_id = NEW.user_id AND c.creator_user_id IS NULL
          AND c.creator_absent_reason = 'left' AND c.state NOT IN ('deleting', 'deleted')
          AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.user_id AND u.auth_status = 'active' AND u.deleted_at IS NULL)
          AND NOT public.organization_member_on_hold(NEW.org_id, NEW.user_id, 10, 5)
        FOR UPDATE SKIP LOCKED);
  EXCEPTION WHEN OTHERS THEN NULL; -- Never fails the membership: the lifecycle's sweep restores what this skipped.
  END;
  PERFORM set_config('app.cloud_team_ownership',coalesce(previous_ownership,''),true);
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new retention trigger functions
REVOKE ALL ON FUNCTION cloud_v2_restore_returning_private() FROM PUBLIC;
CREATE TRIGGER cloud_v2_private_member_returned AFTER INSERT ON organization_members
  FOR EACH ROW EXECUTE FUNCTION cloud_v2_restore_returning_private();

-- The automatic-archive notice: one mail per person per archive run.
-- zeros-expand-exception: widen-check Replaces the template list with a superset that adds one template
ALTER TABLE security_notification_outbox DROP CONSTRAINT security_notification_outbox_template_check;
ALTER TABLE security_notification_outbox
  ADD CONSTRAINT security_notification_outbox_template_check CHECK (template IN (
    'account_identity_disabled', 'account_recovered',
    'sessions_revoked', 'organization_access_revoked',
    'account_deletion_scheduled', 'account_deletion_restored',
    'account_deletion_completed', 'organization_deletion_scheduled',
    'organization_deletion_restored', 'organization_deletion_completed',
    'cloud_workspaces_archived'
  ));
CREATE UNIQUE INDEX security_notification_outbox_archive_run ON security_notification_outbox ((payload->>'run'), user_id)
  WHERE template = 'cloud_workspaces_archived';
