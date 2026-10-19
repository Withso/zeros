-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A NULL opt-in keeps the legacy owner/interactive lifetime. New registrations
-- may opt in only after the actual supervisor and control plane negotiate it.
ALTER TABLE cloud_workspace_engine_instances
  ADD COLUMN coordinator_version smallint CHECK (coordinator_version = 1),
  ADD COLUMN interactive_revision bigint NOT NULL DEFAULT 0 CHECK (interactive_revision >= 0),
  ADD COLUMN interactive_frontend_id uuid,
  ADD COLUMN interactive_ready_until timestamptz CHECK (isfinite(interactive_ready_until)),
  ADD CONSTRAINT cloud_coordinator_ready_shape CHECK (interactive_ready_until IS NULL OR
    (coordinator_version IS NOT DISTINCT FROM 1 AND NOT (interactive_frontend_id IS NULL)));

-- Pure row predicate, security invoker: no table read or RLS bypass. Execution
-- authority deliberately keeps its original lease and does not call this.
CREATE FUNCTION cloud_workspace_engine_interactive_live(engine cloud_workspace_engine_instances) RETURNS boolean
LANGUAGE sql VOLATILE PARALLEL SAFE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT engine.coordinator_version IS NULL OR
    (engine.interactive_frontend_id IS NOT NULL AND engine.interactive_ready_until > clock_timestamp()) IS TRUE
$$;

-- Projection/access prefilter for paths that historically did not need an
-- engine (single-member previews). Only the newest enrollment may select the
-- new rule; a retired predecessor cannot fence its replacement forever.
CREATE FUNCTION cloud_workspace_interactive_live(target_workspace uuid, target_org uuid, target_generation integer) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT coalesce((SELECT engine.coordinator_version IS NULL OR
      (engine.state='ready' AND engine.revoked_at IS NULL AND engine.lease_expires_at>clock_timestamp()
        AND cloud_workspace_engine_interactive_live(engine))
    FROM cloud_workspace_engine_instances engine
    WHERE engine.workspace_id=target_workspace AND engine.org_id=target_org AND engine.generation=target_generation
    ORDER BY engine.enrollment_order DESC LIMIT 1),true)
$$;

-- Reuse the engine-health deadline job. Later proofs do not produce another
-- job write: the existing earlier wake re-reads and reschedules the deadline.
CREATE FUNCTION cloud_coordinator_readiness_job() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM enqueue_cloud_lifecycle_job('cloud_engine_health', NEW.workspace_id, NEW.org_id, NEW.interactive_ready_until);
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_coordinator_readiness_job
  AFTER UPDATE OF interactive_ready_until ON cloud_workspace_engine_instances
  FOR EACH ROW WHEN (NEW.interactive_ready_until IS NOT NULL AND
    (OLD.interactive_ready_until IS NULL OR NEW.interactive_ready_until < OLD.interactive_ready_until))
  EXECUTE FUNCTION cloud_coordinator_readiness_job();
