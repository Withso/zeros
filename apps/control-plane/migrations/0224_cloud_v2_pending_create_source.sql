-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A create can return before its GitHub checks. The lifecycle runs them
-- before any VM exists, then sets the source scope once. Until then the row
-- is pending: it holds no scope and no sandbox, and source checks refuse it.
-- Older code never sets pending, so it keeps 0207's immutable scope.
ALTER TABLE cloud_v2_workspaces ADD COLUMN source_pending boolean NOT NULL DEFAULT false;
ALTER TABLE cloud_v2_workspaces ADD CONSTRAINT cloud_v2_workspaces_source_pending_check
  CHECK (NOT source_pending OR (source_repositories IS NULL AND boat_sandbox_id IS NULL));

-- zeros-expand-exception: pending-source-scope Admits only the one NULL to scope transition of a pending, sandbox-free creating row; every other scope change is still refused.
CREATE OR REPLACE FUNCTION cloud_v2_preserve_source_scope() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF OLD.source_repositories IS DISTINCT FROM NEW.source_repositories AND NOT (
      OLD.source_repositories IS NULL AND coalesce(cardinality(NEW.source_repositories), 0) > 0
      AND OLD.source_pending AND NOT NEW.source_pending
      AND OLD.state = 'creating' AND NEW.state = 'creating'
      AND OLD.boat_sandbox_id IS NULL AND NEW.boat_sandbox_id IS NULL) THEN
    RAISE EXCEPTION 'workspace source scope is immutable';
  END IF;
  RETURN NEW;
END;
$$;

-- Pending ends once, together with its scope, and never starts again.
CREATE FUNCTION cloud_v2_preserve_source_pending() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.source_pending AND NOT OLD.source_pending THEN
    RAISE EXCEPTION 'workspace source pending cannot be restored';
  END IF;
  IF OLD.source_pending AND NOT NEW.source_pending AND NEW.source_repositories IS NULL THEN
    RAISE EXCEPTION 'workspace source pending ends only with a scope';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_v2_preserve_source_pending BEFORE UPDATE OF source_pending
ON cloud_v2_workspaces FOR EACH ROW EXECUTE FUNCTION cloud_v2_preserve_source_pending();
-- zeros-expand-exception: privilege-tightening Withdraws default PUBLIC EXECUTE on the new trigger-only function; no existing caller loses access.
REVOKE ALL ON FUNCTION cloud_v2_preserve_source_pending() FROM PUBLIC;
