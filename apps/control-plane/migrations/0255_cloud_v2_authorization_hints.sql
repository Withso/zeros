-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
-- Commit-time hints for the control plane's in-memory execution token verdicts
-- (src/cloud/execution/authorization-cache.ts). Removals, Stop and outcomes already end the context row, which notifies
-- zeros_cloud_v2_execution; these triggers cover the inputs of the token check that the fence does not turn into a
-- context change. The payload names a scope only (w:<workspace>, u:<user> or o:<organization>); listeners drop the
-- matching entries and reload from SQL, never trusting values from the hint. A lost hint costs at most the cache's
-- 5 s age bound. Every trigger is column-scoped and fires only on a real change, so renewals, material writes and
-- history never notify (NOTIFY serializes committing transactions).
CREATE FUNCTION notify_cloud_v2_authorization() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  row_value jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  id text := row_value ->> TG_ARGV[1];
BEGIN
  IF id IS NOT NULL THEN
    PERFORM pg_notify('zeros_cloud_v2_authorization', TG_ARGV[0] || ':' || id);
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) ->> TG_ARGV[1]) IS DISTINCT FROM id AND (to_jsonb(OLD) ->> TG_ARGV[1]) IS NOT NULL THEN
    PERFORM pg_notify('zeros_cloud_v2_authorization', TG_ARGV[0] || ':' || (to_jsonb(OLD) ->> TG_ARGV[1]));
  END IF;
  RETURN NULL;
END $$;

-- Workspace columns the token check reads that no fence watches. acting_user_boot_ids changes once per worker boot.
-- sync_context_boot_ids is read only for client contexts, which carry no proxy or API token.
CREATE TRIGGER zz_cloud_v2_authorization AFTER UPDATE OF api_access, acting_user_boot_ids,
  source_pending, source_repositories, repository, execution_intent_id, execution_initiator_user_id ON cloud_v2_workspaces
  FOR EACH ROW WHEN (OLD.api_access IS DISTINCT FROM NEW.api_access
    OR OLD.acting_user_boot_ids IS DISTINCT FROM NEW.acting_user_boot_ids
    OR OLD.source_pending IS DISTINCT FROM NEW.source_pending
    OR OLD.source_repositories IS DISTINCT FROM NEW.source_repositories
    OR OLD.repository IS DISTINCT FROM NEW.repository
    OR OLD.execution_intent_id IS DISTINCT FROM NEW.execution_intent_id
    OR OLD.execution_initiator_user_id IS DISTINCT FROM NEW.execution_initiator_user_id)
  EXECUTE FUNCTION notify_cloud_v2_authorization('w', 'id');

CREATE TRIGGER zz_cloud_v2_authorization AFTER INSERT OR UPDATE OR DELETE ON cloud_v2_github_sources
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_v2_authorization('w', 'workspace_id');

-- A person's own workspace API setting (cloud/api/credentials.ts).
CREATE TRIGGER zz_cloud_v2_authorization AFTER INSERT OR DELETE ON cloud_api_access_settings
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_v2_authorization('u', 'user_id');
CREATE TRIGGER zz_cloud_v2_authorization_update AFTER UPDATE OF workspace_api_access, user_id ON cloud_api_access_settings
  FOR EACH ROW WHEN (OLD.workspace_api_access IS DISTINCT FROM NEW.workspace_api_access OR OLD.user_id IS DISTINCT FROM NEW.user_id)
  EXECUTE FUNCTION notify_cloud_v2_authorization('u', 'user_id');

-- The one-way sender cut (0254) writes only sender_ended_at, which no context trigger sees. At most once per turn.
CREATE TRIGGER zz_cloud_v2_authorization AFTER UPDATE OF sender_ended_at ON cloud_v2_execution_contexts
  FOR EACH ROW WHEN (OLD.sender_ended_at IS NULL AND NEW.sender_ended_at IS NOT NULL)
  EXECUTE FUNCTION notify_cloud_v2_authorization('w', 'workspace_id');

-- Hold windows. A window opening on the clock has no write and is found by the 5 s age bound.
CREATE TRIGGER zz_cloud_v2_authorization AFTER INSERT OR DELETE ON organization_member_seat_periods
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_v2_authorization('o', 'org_id');
CREATE TRIGGER zz_cloud_v2_authorization_update AFTER UPDATE OF hold_periods, org_id ON organization_member_seat_periods
  FOR EACH ROW WHEN (OLD.hold_periods IS DISTINCT FROM NEW.hold_periods OR OLD.org_id IS DISTINCT FROM NEW.org_id)
  EXECUTE FUNCTION notify_cloud_v2_authorization('o', 'org_id');
