-- Retired engine receipts keep the fence that originally admitted them. A
-- mutable setup fence cannot be their foreign-key target: retrying that setup
-- would otherwise fail even after every old engine and grant was revoked.
ALTER TABLE cloud_workspace_engine_instances
  DROP CONSTRAINT cloud_workspace_engine_instan_setup_run_id_workspace_id_ge_fkey,
  ADD CONSTRAINT cloud_engine_setup_identity_fkey
    FOREIGN KEY (setup_run_id, workspace_id, generation, org_id)
    REFERENCES cloud_workspace_setup_runs(id, workspace_id, generation, org_id)
    ON DELETE CASCADE;

CREATE FUNCTION enforce_cloud_engine_current_setup_fence()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.state IN ('starting', 'ready') AND NOT EXISTS (
    SELECT 1 FROM cloud_workspace_setup_runs setup
    WHERE setup.id = NEW.setup_run_id AND setup.workspace_id = NEW.workspace_id
      AND setup.generation = NEW.generation AND setup.org_id = NEW.org_id
      AND setup.execution_fence = NEW.setup_execution_fence
      AND setup.state IN ('running', 'succeeded')
  ) THEN
    RAISE EXCEPTION 'engine setup execution fence is not current' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_engine_current_setup_fence
  BEFORE INSERT OR UPDATE OF state, setup_run_id, setup_execution_fence, workspace_id, generation, org_id
  ON cloud_workspace_engine_instances FOR EACH ROW
  EXECUTE FUNCTION enforce_cloud_engine_current_setup_fence();

CREATE FUNCTION enforce_cloud_setup_retry_retirement()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.execution_fence <> OLD.execution_fence AND EXISTS (
    SELECT 1 FROM cloud_workspace_engine_instances engine
    WHERE engine.setup_run_id = OLD.id AND engine.state IN ('starting', 'ready')
  ) THEN
    RAISE EXCEPTION 'setup retry requires retiring old engine authority' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_setup_retry_retirement
  BEFORE UPDATE OF execution_fence ON cloud_workspace_setup_runs FOR EACH ROW
  EXECUTE FUNCTION enforce_cloud_setup_retry_retirement();
