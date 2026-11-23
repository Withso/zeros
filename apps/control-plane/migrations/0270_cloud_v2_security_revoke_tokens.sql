-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A revoking security event stopped the matching workspaces and expired their tokens in one statement. A workspace that
-- leaves creating/starting/running, or is archived, deletes its API tokens from a BEFORE UPDATE trigger
-- (cloud_api_token_lifetime, 0226), so that statement then reached a token row its own trigger had just deleted and
-- failed (SQLSTATE 27000), and the whole write that recorded the event with it. Every running workspace holds the
-- worker's API token, so an account revocation, a member's removal or an authorization change for a person with a live
-- workspace was refused. The workspaces are updated first, as before, and their remaining tokens expired in a second
-- statement, after that trigger's delete has completed. Nothing else changes.
-- zeros-expand-exception: security-revoke-tokens A revoking event expires the stopped workspaces' tokens in its own statement
CREATE OR REPLACE FUNCTION revoke_cloud_v2_security_access() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE revoked uuid[];
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
    WITH changed AS (
      UPDATE public.cloud_v2_workspaces w
      SET access_epoch = access_epoch + 1, worker_token_hash = NULL,
          state = CASE WHEN state IN ('creating','starting','running') THEN 'stopping' ELSE state END,
          attempts = 0, next_attempt_at = NULL, updated_at = clock_timestamp()
      WHERE state <> 'deleted' AND (w.execution_mode<>'active' OR NEW.user_id IS NULL)
        AND (NEW.user_id IS NULL OR w.creator_user_id = NEW.user_id)
        AND (NEW.org_id IS NULL OR w.org_id = NEW.org_id)
        AND (NEW.workspace_id IS NULL OR w.id = NEW.workspace_id)
      RETURNING w.id
    ) SELECT array_agg(id) INTO revoked FROM changed;
    -- Its own statement: cloud_api_token_lifetime has already deleted the API tokens of every workspace it stopped.
    UPDATE public.cloud_v2_tokens SET expires_at = least(expires_at, clock_timestamp())
      WHERE workspace_id = ANY(revoked);
    PERFORM pg_notify('zeros_security_event', '');
  END IF;
  RETURN NEW;
END;
$$;
