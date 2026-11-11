-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_v2_connected_macs ADD COLUMN sync_wanted boolean NOT NULL DEFAULT false;

-- Preserve mirrors already running when desired state is first introduced.
UPDATE cloud_v2_connected_macs SET sync_wanted=true WHERE syncing AND disconnected_at IS NULL;

-- Released control planes still write these connection fields without sync_wanted.
CREATE FUNCTION clear_connected_mac_sync_wanted() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.sync_wanted := false;
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new sync-intent fencing function
REVOKE ALL ON FUNCTION clear_connected_mac_sync_wanted() FROM PUBLIC;
CREATE TRIGGER connected_mac_sync_wanted_fence BEFORE UPDATE OF disconnected_at,registration_id ON cloud_v2_connected_macs
  FOR EACH ROW WHEN (NEW.disconnected_at IS NOT NULL OR NEW.registration_id IS DISTINCT FROM OLD.registration_id)
  EXECUTE FUNCTION clear_connected_mac_sync_wanted();
