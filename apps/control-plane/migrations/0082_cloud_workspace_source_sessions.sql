-- A device grant is not a substitute for the issuing authenticated session.
-- Older actor-v2 grants were never enabled publicly; fail them closed instead
-- of guessing which WorkOS session authorized them.
ALTER TABLE cloud_workspace_actor_sessions
  ADD COLUMN auth_provider text CHECK (auth_provider='workos'),
  ADD COLUMN auth_subject text CHECK (length(auth_subject) BETWEEN 1 AND 512),
  ADD COLUMN auth_session_id text CHECK (length(auth_session_id) BETWEEN 1 AND 512),
  ADD COLUMN auth_session_created_at timestamptz;
UPDATE cloud_workspace_actor_sessions SET revoked_at=coalesce(revoked_at,now());
ALTER TABLE cloud_workspace_actor_sessions ADD CONSTRAINT cloud_actor_source_session_required CHECK (
  revoked_at IS NOT NULL OR (auth_provider IS NOT NULL AND auth_subject IS NOT NULL AND auth_session_id IS NOT NULL AND auth_session_created_at IS NOT NULL));
CREATE INDEX cloud_actor_source_session ON cloud_workspace_actor_sessions(auth_provider,auth_session_id) WHERE revoked_at IS NULL;

CREATE FUNCTION cloud_workspace_actor_auth_live(target_user_id uuid,source_provider text,source_subject text,source_session_id text,source_session_created_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT app_is_system() AND EXISTS (
    SELECT 1 FROM auth_sessions source
    JOIN user_identities identity ON identity.provider::text=source.provider AND identity.provider_sub=source.provider_sub
      AND identity.user_id=source.user_id AND identity.status='active' AND identity.email_verified_at IS NOT NULL
    JOIN users account ON account.id=source.user_id AND account.auth_status='active' AND account.deleted_at IS NULL
    WHERE source.provider=source_provider AND source.provider='workos' AND source.provider_sub=source_subject
      AND source.provider_session_id=source_session_id AND source.user_id=target_user_id
      AND source.created_at=source_session_created_at AND source.status='active' AND source.revoked_at IS NULL
      AND (source.provider_session_expires_at IS NULL OR source.provider_session_expires_at>now())
  )
$$;
REVOKE ALL ON FUNCTION cloud_workspace_actor_auth_live(uuid,text,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_actor_auth_live(uuid,text,text,text,timestamptz) TO zeros_app;

-- Preserve the source authority of an autonomous queued request. Socket and
-- actor-admission TTLs do not cancel it; explicit WorkOS revocation does.
ALTER TABLE cloud_workspace_commands ADD COLUMN actor_source_session_id uuid
  REFERENCES cloud_workspace_actor_sessions(id) ON DELETE SET NULL;
CREATE INDEX cloud_command_source_session ON cloud_workspace_commands(actor_source_session_id)
  WHERE actor_source_session_id IS NOT NULL;
