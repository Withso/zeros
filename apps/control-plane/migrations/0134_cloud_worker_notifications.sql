-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Commit-scoped scheduling hints only. No row identity, user material or
-- authority leaves these tables; workers still claim through existing fences.
-- Older replicas ignore these channels and continue their normal polling.
CREATE FUNCTION notify_cloud_worker_available() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_notify(TG_ARGV[0], '');
  RETURN NEW;
END $$;

CREATE TRIGGER cloud_lifecycle_work_available
  AFTER INSERT OR UPDATE OF state, next_attempt_at ON cloud_workspace_lifecycle_intents
  FOR EACH ROW WHEN (
    NEW.state IN ('queued', 'observing') AND NEW.next_attempt_at <= now()
  ) EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_lifecycle_work');

-- Completing a prerequisite can admit a queued, dependent lifecycle intent.
CREATE TRIGGER cloud_lifecycle_prerequisite_completed
  AFTER UPDATE OF state ON cloud_workspace_lifecycle_intents
  FOR EACH ROW WHEN (NEW.state = 'succeeded' AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_lifecycle_work');

CREATE TRIGGER cloud_setup_work_available
  AFTER INSERT OR UPDATE OF state, next_attempt_at ON cloud_workspace_setup_runs
  FOR EACH ROW WHEN (NEW.state = 'queued' AND NEW.next_attempt_at <= now())
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_setup_work');

-- Setup may be queued before the VM is running. Wake again when the binding
-- or workspace becomes eligible, regardless of which transaction wrote first.
CREATE TRIGGER cloud_setup_provider_available
  AFTER INSERT OR UPDATE OF observed_state, provider_resource_id ON cloud_workspace_provider_bindings
  FOR EACH ROW WHEN (NEW.observed_state = 'running' AND NEW.provider_resource_id IS NOT NULL)
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_setup_work');

CREATE TRIGGER cloud_setup_workspace_available
  AFTER INSERT OR UPDATE OF status, desired_state, current_generation ON cloud_workspaces
  FOR EACH ROW WHEN (NEW.status = 'setting_up' AND NEW.desired_state = 'running' AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION notify_cloud_worker_available('zeros_cloud_setup_work');
