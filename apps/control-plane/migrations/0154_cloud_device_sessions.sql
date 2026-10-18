-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- S3 device sessions: one per (account, CP session, device), reused while
-- unexpired so a reconnecting device stream can resume. Each row holds at
-- most one outstanding stream ticket, stored only as a SHA-256 digest. The
-- ticket is single-use: realtime consumes it with one conditional UPDATE.
-- Rows cascade with the account and the device, so account deletion and
-- device removal never wait on them; no organization is referenced, so an
-- organization purge does not touch them either.
CREATE TABLE cloud_device_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  -- The provider session that authorized issuance; null for a legacy token
  -- without one. Session revocation is re-read at every consume.
  provider_session_id text CHECK (provider_session_id IS NULL OR char_length(provider_session_id) BETWEEN 1 AND 512),
  ticket_hash bytea CHECK (ticket_hash IS NULL OR octet_length(ticket_hash) = 32),
  ticket_expires_at timestamptz,
  ticket_consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (device_id, user_id) REFERENCES devices(id, user_id) ON DELETE CASCADE,
  CHECK ((ticket_hash IS NULL) = (ticket_expires_at IS NULL)),
  CHECK (ticket_consumed_at IS NULL OR ticket_hash IS NOT NULL),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX cloud_device_sessions_ticket ON cloud_device_sessions(ticket_hash) WHERE ticket_hash IS NOT NULL;
CREATE INDEX cloud_device_sessions_device ON cloud_device_sessions(device_id, user_id);
CREATE INDEX cloud_device_sessions_user ON cloud_device_sessions(user_id, expires_at);

ALTER TABLE cloud_device_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_device_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_device_sessions FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_device_sessions TO zeros_app;

-- S3 catalogVersion: one global, monotonic sequence, so it is monotonic per
-- account too. Every committed change of a workspace document's version (and
-- every insert or hard delete) draws the next value; the catalog response
-- reports the sequence position read before its page. The NOTIFY payload
-- (`<workspace>:<catalog version>`) is only a hint: realtime re-reads the
-- workspace and the account's access from current rows. Membership and
-- authorization changes reach realtime through the security-event feed.
CREATE SEQUENCE cloud_catalog_version_seq AS bigint;
GRANT USAGE, SELECT ON SEQUENCE cloud_catalog_version_seq TO zeros_app;

CREATE FUNCTION notify_cloud_workspace_catalog() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('zeros_cloud_workspace_catalog',
    COALESCE(NEW.id, OLD.id)::text || ':' || nextval('public.cloud_catalog_version_seq')::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER cloud_workspace_catalog_inserted
  AFTER INSERT ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_workspace_catalog();
CREATE TRIGGER cloud_workspace_catalog_changed
  AFTER UPDATE OF version ON cloud_workspaces
  FOR EACH ROW WHEN (OLD.version IS DISTINCT FROM NEW.version)
  EXECUTE FUNCTION notify_cloud_workspace_catalog();
CREATE TRIGGER cloud_workspace_catalog_deleted
  AFTER DELETE ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_workspace_catalog();
