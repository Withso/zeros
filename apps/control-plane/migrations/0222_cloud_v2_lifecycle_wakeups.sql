-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Wakes the cloud lifecycle as soon as a row needs it, so an idle control
-- plane sweeps once a minute instead of every two seconds. An empty payload
-- lets Postgres fold a transaction's repeated notices into one.
CREATE FUNCTION notify_cloud_v2_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('zeros_cloud_v2_lifecycle', '');
  RETURN NULL;
END $$;

CREATE TRIGGER zz_cloud_v2_lifecycle_insert AFTER INSERT ON cloud_v2_workspaces
  FOR EACH ROW WHEN (NEW.state IN ('creating', 'starting', 'stopping', 'deleting'))
  EXECUTE FUNCTION notify_cloud_v2_lifecycle();
CREATE TRIGGER zz_cloud_v2_lifecycle_state AFTER UPDATE OF state ON cloud_v2_workspaces
  FOR EACH ROW WHEN (NEW.state IN ('creating', 'starting', 'stopping', 'deleting') AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION notify_cloud_v2_lifecycle();
CREATE TRIGGER zz_cloud_v2_lifecycle_prompt_wake AFTER INSERT OR UPDATE OF wake_after_stop ON cloud_v2_prompt_outbox
  FOR EACH ROW WHEN (NEW.wake_after_stop)
  EXECUTE FUNCTION notify_cloud_v2_lifecycle();
CREATE TRIGGER zz_cloud_v2_lifecycle_builds AFTER INSERT OR UPDATE OF state, cleanup_requested_at ON cloud_v2_computer_builds
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_v2_lifecycle();
