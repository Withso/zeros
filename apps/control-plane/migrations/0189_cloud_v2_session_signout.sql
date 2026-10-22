-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A device sign-out changes app admission, not the creator's membership or
-- running VM. Keep its worker/proxy credentials so turns and final HTTPS
-- history writes continue. Account/organization access loss still stops it.
-- zeros-expand-exception: session-signout Preserve app revocation while allowing a signed-out device's active VM to finish its turn
CREATE OR REPLACE FUNCTION revoke_cloud_v2_security_access() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.kind = 'session.revoked' AND NEW.user_id IS NOT NULL THEN
    WITH changed AS (
      UPDATE public.cloud_v2_workspaces w SET access_epoch = access_epoch + 1
      WHERE state <> 'deleted' AND w.creator_user_id = NEW.user_id
        AND (NEW.org_id IS NULL OR w.org_id = NEW.org_id)
        AND (NEW.workspace_id IS NULL OR w.id = NEW.workspace_id)
      RETURNING w.id
    ) UPDATE public.cloud_v2_tokens SET expires_at = least(expires_at, clock_timestamp())
      WHERE workspace_id IN (SELECT id FROM changed)
        AND kind = 'connect' AND user_id = NEW.user_id AND used_at IS NULL;
    PERFORM pg_notify('zeros_security_event', '');
  ELSIF NEW.kind IN ('account.revoked', 'account.authorization_changed',
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
    PERFORM pg_notify('zeros_security_event', '');
  END IF;
  RETURN NEW;
END;
$$;
