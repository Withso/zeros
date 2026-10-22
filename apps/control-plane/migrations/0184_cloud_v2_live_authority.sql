-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A room retains the generation admitted by its ticket/worker credential.
-- Revocation changes it in the same transaction as the security event, even
-- when the realtime process is offline. Session revocation conservatively
-- retires all of that creator's cloud access; a new login may reconnect.
ALTER TABLE cloud_v2_workspaces ADD COLUMN access_epoch bigint NOT NULL DEFAULT 0;

CREATE FUNCTION revoke_cloud_v2_security_access() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.kind IN ('account.revoked', 'account.authorization_changed', 'session.revoked',
                  'organization.access_revoked', 'workspace.authorization_changed')
     AND (NEW.user_id IS NOT NULL OR NEW.org_id IS NOT NULL OR NEW.workspace_id IS NOT NULL) THEN
    WITH revoked AS (
      UPDATE public.cloud_v2_workspaces w
      SET access_epoch = access_epoch + 1, worker_token_hash = NULL,
          state = CASE WHEN state IN ('creating','starting','running') THEN 'stopping' ELSE state END,
          attempts = 0, next_attempt_at = NULL, updated_at = clock_timestamp()
      WHERE state <> 'deleted'
        AND (NEW.user_id IS NULL OR w.creator_user_id = NEW.user_id)
        AND (NEW.org_id IS NULL OR w.org_id = NEW.org_id)
        AND (NEW.workspace_id IS NULL OR w.id = NEW.workspace_id)
      RETURNING w.id
    ) UPDATE public.cloud_v2_tokens SET expires_at = least(expires_at, clock_timestamp())
      WHERE workspace_id IN (SELECT id FROM revoked);
    -- Transactional NOTIFY reaches live rooms only after the revocation commits;
    -- it does not wait for the separate security-feed publication scheduler.
    PERFORM pg_notify('zeros_security_event', '');
  END IF;
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION revoke_cloud_v2_security_access() FROM PUBLIC;
CREATE TRIGGER cloud_v2_security_access AFTER INSERT ON security_events
FOR EACH ROW EXECUTE FUNCTION revoke_cloud_v2_security_access();
