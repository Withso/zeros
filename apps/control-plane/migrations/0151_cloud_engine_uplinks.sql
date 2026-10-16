-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Durable presence for engine uplinks held by realtime replicas. Liveness is
-- authoritative in realtime memory; this row changes only on transitions
-- (connected, readiness changed, lost) plus a coarse watermark, so drift and
-- cleanup jobs can still reason about engines while realtime is down. The
-- HTTP heartbeat still owns the engine lease.
-- connection_id fences writes from a connection that was replaced: only the
-- connection that last connected may update or close the row, and a delayed
-- connect never overwrites a newer one.
CREATE TABLE cloud_workspace_engine_uplinks (
  engine_instance_id uuid PRIMARY KEY
    REFERENCES cloud_workspace_engine_instances(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  connection_id uuid NOT NULL,
  realtime_instance text NOT NULL CHECK (realtime_instance ~ '^[A-Za-z0-9:._-]{1,128}$'),
  protocol integer NOT NULL CHECK (protocol BETWEEN 1 AND 65535),
  connected boolean NOT NULL,
  ready boolean NOT NULL DEFAULT false,
  phase text CHECK (phase IN ('starting','preparing','ready','degraded','stopping')),
  connected_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  disconnected_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (connected = (disconnected_at IS NULL)),
  CHECK (last_seen_at >= connected_at)
);

CREATE INDEX cloud_workspace_engine_uplinks_workspace ON cloud_workspace_engine_uplinks(workspace_id, generation);

-- One owner across realtime instances: a new connection on another instance
-- tells the instance holding an older uplink to close it with 4409. The
-- payload is a hint from the committed row: engine:connection:connected_at_ms.
CREATE FUNCTION notify_cloud_engine_uplink_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('zeros_cloud_engine_uplink_owner', NEW.engine_instance_id::text || ':' ||
    NEW.connection_id::text || ':' || round(extract(epoch FROM NEW.connected_at) * 1000)::bigint::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER cloud_engine_uplink_owner_inserted
  AFTER INSERT ON cloud_workspace_engine_uplinks
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_engine_uplink_owner();
CREATE TRIGGER cloud_engine_uplink_owner_changed
  AFTER UPDATE OF connection_id ON cloud_workspace_engine_uplinks
  FOR EACH ROW WHEN (OLD.connection_id IS DISTINCT FROM NEW.connection_id)
  EXECUTE FUNCTION notify_cloud_engine_uplink_owner();

-- Teardown on authority loss: realtime re-reads authority for the affected
-- uplinks and closes those that are no longer current with 4403. Only
-- authority-relevant changes notify; per-heartbeat lease renewals do not.
CREATE FUNCTION notify_cloud_engine_uplink_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'cloud_workspaces' THEN
    PERFORM pg_notify('zeros_cloud_engine_uplink_authority', 'w:' || COALESCE(NEW.id, OLD.id)::text);
  ELSE
    PERFORM pg_notify('zeros_cloud_engine_uplink_authority', 'e:' || COALESCE(NEW.id, OLD.id)::text);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER cloud_engine_uplink_authority_engine_changed
  AFTER UPDATE OF state, revoked_at, heartbeat_token_hash, final_checkpoint_at ON cloud_workspace_engine_instances
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
    OR OLD.heartbeat_token_hash IS DISTINCT FROM NEW.heartbeat_token_hash
    OR OLD.final_checkpoint_at IS DISTINCT FROM NEW.final_checkpoint_at)
  EXECUTE FUNCTION notify_cloud_engine_uplink_authority();
CREATE TRIGGER cloud_engine_uplink_authority_engine_deleted
  AFTER DELETE ON cloud_workspace_engine_instances
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_engine_uplink_authority();
CREATE TRIGGER cloud_engine_uplink_authority_workspace_changed
  AFTER UPDATE OF current_generation, desired_state, deleted_at, status, authority_epoch ON cloud_workspaces
  FOR EACH ROW WHEN (OLD.current_generation IS DISTINCT FROM NEW.current_generation
    OR OLD.desired_state IS DISTINCT FROM NEW.desired_state OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    OR OLD.authority_epoch IS DISTINCT FROM NEW.authority_epoch
    OR (OLD.status IN ('setting_up','ready','busy')) IS DISTINCT FROM (NEW.status IN ('setting_up','ready','busy')))
  EXECUTE FUNCTION notify_cloud_engine_uplink_authority();

ALTER TABLE cloud_workspace_engine_uplinks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_engine_uplinks FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_workspace_engine_uplinks FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_workspace_engine_uplinks TO zeros_app;
