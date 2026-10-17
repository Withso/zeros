-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A healthy running compute lease is re-checked at its renewal point, up to
-- ten minutes away, instead of every 15 s. A change that the check acts on
-- must not wait for it: a stop or other desired-state change, a new
-- generation, an ownership or billing-epoch change, deletion, or a move into
-- or out of the failed or serving statuses re-checks every unsettled lease of
-- the workspace at once (0150's trigger then makes its job due).
CREATE FUNCTION recheck_cloud_workspace_compute_leases()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- A lease under check is re-checked too: its worker keeps a check requested
  -- while it ran. SKIP LOCKED, so a workspace write never waits for a lease
  -- row; a lease skipped here is still checked at its scheduled time, at most
  -- ten minutes away.
  UPDATE managed_compute_allocation_leases lease
  SET next_check_at = clock_timestamp()
  FROM (
    SELECT id FROM managed_compute_allocation_leases
    WHERE workspace_id = NEW.id AND org_id = NEW.org_id AND state <> 'settled'
      AND (next_check_at > clock_timestamp() OR lease_owner IS NOT NULL)
    FOR UPDATE SKIP LOCKED
  ) due
  WHERE lease.id = due.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_workspace_compute_lease_recheck
  AFTER UPDATE OF desired_state, current_generation, owner_user_id,
    current_billing_epoch, status, deleted_at ON cloud_workspaces
  FOR EACH ROW
  WHEN (
    OLD.desired_state IS DISTINCT FROM NEW.desired_state
    OR OLD.current_generation IS DISTINCT FROM NEW.current_generation
    OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR OLD.current_billing_epoch IS DISTINCT FROM NEW.current_billing_epoch
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    OR (OLD.status = 'failed') IS DISTINCT FROM (NEW.status = 'failed')
    OR (OLD.status IN ('ready', 'busy')) IS DISTINCT FROM (NEW.status IN ('ready', 'busy'))
  )
  EXECUTE FUNCTION recheck_cloud_workspace_compute_leases();

-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION recheck_cloud_workspace_compute_leases() FROM PUBLIC;
