-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Bind each one-use app ticket to its verified WorkOS session. Older tickets
-- and legacy authentication retain NULL until those short-lived tickets expire.
-- Worker/proxy credentials deliberately do not depend on a desktop session.
ALTER TABLE cloud_v2_tokens ADD COLUMN provider_session_id text;
CREATE INDEX cloud_v2_connect_session_idx ON cloud_v2_tokens (user_id, provider_session_id)
  WHERE kind = 'connect' AND used_at IS NULL;

-- zeros-expand-exception: session-scoped-signout Limit device sign-out to its exact app session while retaining account and membership revocation
CREATE OR REPLACE FUNCTION revoke_cloud_v2_security_access() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.kind = 'session.revoked' THEN
    -- Missing session identity is never authority to revoke sibling devices.
    -- The relay also reads auth_sessions for open clients and ticket admission.
    UPDATE public.cloud_v2_tokens t SET expires_at = least(t.expires_at, clock_timestamp())
      FROM public.cloud_v2_workspaces w
      WHERE t.workspace_id = w.id AND t.kind = 'connect' AND t.used_at IS NULL
        AND t.user_id = NEW.user_id AND t.provider_session_id = NEW.provider_session_id
        AND (NEW.org_id IS NULL OR w.org_id = NEW.org_id)
        AND (NEW.workspace_id IS NULL OR w.id = NEW.workspace_id);
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
