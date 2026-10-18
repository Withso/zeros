-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- The paid-authority reconciler checks provider authority for the
-- workspace's current generation and schedules its next check from that
-- generation's credential expiry. A rebuild, rollback, recovery or runtime
-- transfer moves current_generation, and until now waited for a check that
-- was scheduled for the previous generation. Queue one at once, as 0046 does
-- for the workspace's other authority columns.
CREATE FUNCTION enqueue_cloud_workspace_generation_authority_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO cloud_workspace_paid_authority_checks (
    workspace_id, org_id, next_check_at, reason, enqueued_at, updated_at
  ) VALUES (
    NEW.id, NEW.org_id, now(), 'workspace_generation_changed', now(), now()
  )
  ON CONFLICT (workspace_id) DO UPDATE
  SET next_check_at = now(), reason = EXCLUDED.reason,
      enqueued_at = now(), updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_workspace_generation_authority_check
  AFTER UPDATE OF current_generation ON cloud_workspaces
  FOR EACH ROW
  WHEN (
    OLD.current_generation IS DISTINCT FROM NEW.current_generation
    AND NEW.desired_state = 'running'
  )
  EXECUTE FUNCTION enqueue_cloud_workspace_generation_authority_check();

-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION enqueue_cloud_workspace_generation_authority_check() FROM PUBLIC;
