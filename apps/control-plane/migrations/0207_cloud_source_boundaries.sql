-- zeros-migration: expand
-- Only v2 images are captured before repository content or setup is present.
-- Older builders retain v1 during a rolling deployment and cannot produce a
-- source-free image by merely acquiring a new runtime pin.
ALTER TABLE cloud_v2_computer_builds
  ADD COLUMN source_policy_version integer NOT NULL DEFAULT 1 CHECK (source_policy_version IN (1,2));
ALTER TABLE cloud_v2_workspaces ADD COLUMN source_repositories text[];

-- Old snapshots inherited arbitrary caches/artifacts from earlier builds.
-- Conservatively retain every historical repository in their organization,
-- including removed recipe entries. No disk, checkpoint, or user file is erased.
UPDATE cloud_v2_workspaces w SET source_repositories = ARRAY(
  SELECT DISTINCT lower(repository) FROM (
    SELECT w.repository AS repository
    UNION ALL
    SELECT entry->>'repository' FROM cloud_v2_computer_builds b,
      LATERAL jsonb_array_elements(b.recipe->'repositories') entry
    WHERE b.org_id=w.org_id
  ) sources WHERE repository IS NOT NULL ORDER BY lower(repository)
) WHERE w.computer_build_id IS NOT NULL;

-- Restoring a selected checkout cannot prove it contains no copied source.
-- A replacement image must never silently narrow a workspace's source scope.
CREATE FUNCTION cloud_v2_preserve_source_scope() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF OLD.source_repositories IS DISTINCT FROM NEW.source_repositories THEN
    RAISE EXCEPTION 'workspace source scope is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_v2_preserve_source_scope BEFORE UPDATE OF source_repositories
ON cloud_v2_workspaces FOR EACH ROW EXECUTE FUNCTION cloud_v2_preserve_source_scope();
-- zeros-expand-exception: privilege-tightening Withdraws default PUBLIC EXECUTE on the new trigger-only function; no existing caller loses access.
REVOKE ALL ON FUNCTION cloud_v2_preserve_source_scope() FROM PUBLIC;
