-- A point-in-time database restore must find every object its rows reference.
-- Record when a blob lost its last reference; garbage collection keeps a live
-- object for the deployment's configured restore window after that. Erasure
-- and deletions already in flight do not wait.
ALTER TABLE workspace_blobs ADD COLUMN dereferenced_at timestamptz;

CREATE FUNCTION stamp_workspace_blob_dereference() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.reference_count > 0 THEN
    NEW.dereferenced_at := NULL;
  ELSIF OLD.reference_count > 0 THEN
    NEW.dereferenced_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER workspace_blob_dereference
BEFORE UPDATE OF reference_count ON workspace_blobs
FOR EACH ROW WHEN (OLD.reference_count IS DISTINCT FROM NEW.reference_count)
EXECUTE FUNCTION stamp_workspace_blob_dereference();

-- When existing unreferenced live blobs lost their references is unknown, so
-- their window starts now.
UPDATE workspace_blobs SET dereferenced_at = clock_timestamp()
WHERE reference_count = 0 AND state = 'available';
