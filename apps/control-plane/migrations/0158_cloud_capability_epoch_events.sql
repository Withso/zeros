-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- S1 "Revocation": every authority-reducing change writes its epoch bump and
-- a security_events row in the same transaction, so realtime can push
-- `auth.epochs` to the affected engines and `capability.revoked` to device
-- streams within the 2 s budget instead of waiting out the token lifetime.
-- One trigger per epoch source covers every writer, including the 0153
-- membership fan-outs:
--   me  cloud_capability_member_epochs (org, user)
--   ac  users.auth_revision (user)
--   dk  devices.key_version and device revocation (user, device)
--   wa  cloud_workspaces.authority_epoch (org, workspace)
--   wr  cloud_workspaces.access_revision (org, workspace)
-- The row carries routing only: realtime re-reads current epochs for each
-- workspace it serves and never trusts values from the event. The workspace
-- id travels in the payload because security_events.workspace_id is reserved
-- for workspace.authorization_changed (0081). The client event feed never
-- returns this kind (security-events.ts), so no payload reaches a browser.
-- Rows expire after one hour, beyond the 36-minute revocation retention.
ALTER TYPE security_event_kind ADD VALUE IF NOT EXISTS 'capability.epochs_changed';

-- PL/pgSQL so the new enum label is resolved when a trigger fires, after
-- this migration commits, never while it is being added.
--
-- SECURITY DEFINER for the same reason as 0153: the source statements also
-- run in user context and security_events is FORCE RLS and system-only. The
-- functions read only NEW/OLD, take no caller arguments and write nothing
-- but one event row. The EXISTS guards skip an event whose organization or
-- account is vanishing in the same cascade, as 0153 does.
CREATE FUNCTION record_cloud_capability_epoch_event(target_org uuid, target_user uuid, detail jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO security_events(kind, user_id, org_id, payload, expires_at)
  SELECT 'capability.epochs_changed', target_user, target_org, detail, now() + interval '1 hour'
  WHERE (target_org IS NULL OR EXISTS (SELECT 1 FROM organizations WHERE id = target_org))
    AND (target_user IS NULL OR EXISTS (SELECT 1 FROM users WHERE id = target_user));
END $$;

CREATE FUNCTION record_cloud_capability_epoch_event_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'cloud_capability_member_epochs' THEN
    PERFORM record_cloud_capability_epoch_event(NEW.org_id, NEW.user_id, jsonb_build_object('epoch', 'me'));
  ELSIF TG_TABLE_NAME = 'users' THEN
    PERFORM record_cloud_capability_epoch_event(NULL, NEW.id, jsonb_build_object('epoch', 'ac'));
  ELSIF TG_TABLE_NAME = 'devices' THEN
    PERFORM record_cloud_capability_epoch_event(NULL, NEW.user_id, jsonb_build_object('epoch', 'dk', 'deviceId', NEW.id));
  ELSIF TG_TABLE_NAME = 'cloud_workspaces' THEN
    IF NEW.authority_epoch IS DISTINCT FROM OLD.authority_epoch THEN
      PERFORM record_cloud_capability_epoch_event(NEW.org_id, NULL, jsonb_build_object('epoch', 'wa', 'workspaceId', NEW.id));
    END IF;
    IF NEW.access_revision IS DISTINCT FROM OLD.access_revision THEN
      PERFORM record_cloud_capability_epoch_event(NEW.org_id, NULL, jsonb_build_object('epoch', 'wr', 'workspaceId', NEW.id));
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION record_cloud_capability_epoch_event(uuid, uuid, jsonb) FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION record_cloud_capability_epoch_event_trigger() FROM PUBLIC;

-- No-op writes (an upsert or sync that rewrites unchanged values) fire
-- nothing: every trigger is limited to the epoch columns and a WHEN clause.
CREATE TRIGGER cloud_capability_epoch_event_members
  AFTER INSERT ON cloud_capability_member_epochs
  FOR EACH ROW EXECUTE FUNCTION record_cloud_capability_epoch_event_trigger();
CREATE TRIGGER cloud_capability_epoch_event_member_changes
  AFTER UPDATE OF epoch ON cloud_capability_member_epochs
  FOR EACH ROW WHEN (NEW.epoch IS DISTINCT FROM OLD.epoch)
  EXECUTE FUNCTION record_cloud_capability_epoch_event_trigger();
CREATE TRIGGER cloud_capability_epoch_event_accounts
  AFTER UPDATE OF auth_revision ON users
  FOR EACH ROW WHEN (NEW.auth_revision IS DISTINCT FROM OLD.auth_revision)
  EXECUTE FUNCTION record_cloud_capability_epoch_event_trigger();
CREATE TRIGGER cloud_capability_epoch_event_devices
  AFTER UPDATE OF key_version, revoked_at ON devices
  FOR EACH ROW WHEN (NEW.key_version IS DISTINCT FROM OLD.key_version
    OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL))
  EXECUTE FUNCTION record_cloud_capability_epoch_event_trigger();
CREATE TRIGGER cloud_capability_epoch_event_workspaces
  AFTER UPDATE OF authority_epoch, access_revision ON cloud_workspaces
  FOR EACH ROW WHEN (ROW(NEW.authority_epoch, NEW.access_revision) IS DISTINCT FROM ROW(OLD.authority_epoch, OLD.access_revision))
  EXECUTE FUNCTION record_cloud_capability_epoch_event_trigger();
