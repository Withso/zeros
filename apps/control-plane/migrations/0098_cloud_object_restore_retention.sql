-- A point-in-time database restore must find every object its rows reference.
-- PlanetScale keeps 12-hourly backups for 48 hours, so restore points reach
-- about 48 hours back. When a blob loses its last reference, keep its object at
-- least that long; garbage collection already waits for retention_until.
-- Erasure paths mark blobs deleted and are deliberately not retained.
CREATE FUNCTION retain_dereferenced_workspace_blob() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.retention_until := greatest(
    coalesce(OLD.retention_until, '-infinity'::timestamptz),
    clock_timestamp() + interval '48 hours'
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER workspace_blob_restore_retention
BEFORE UPDATE OF reference_count ON workspace_blobs
FOR EACH ROW
WHEN (OLD.reference_count > 0 AND NEW.reference_count = 0
  AND NEW.state IN ('available', 'quarantined', 'deleting'))
EXECUTE FUNCTION retain_dereferenced_workspace_blob();
