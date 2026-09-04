-- ───────────────────────────────────────────────────────────
-- 0041 — provider-connection authority retirement
--
-- A provider connection is execution authority, not metadata. Revoking or
-- invalidating it must fence every capability already issued for a generation
-- bound to that connection. Provider cleanup intentionally remains possible
-- through the generation-pinned credential version so stop/delete recovery can
-- prove the remote resource is gone without re-enabling user or engine access.
-- ───────────────────────────────────────────────────────────

CREATE FUNCTION retire_cloud_workspace_provider_connection_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  retirement_reason text;
BEGIN
  IF OLD.state = 'active' AND NEW.state IN ('revoked', 'invalid') THEN
    retirement_reason := CASE NEW.state
      WHEN 'revoked' THEN 'provider_connection_revoked'
      ELSE 'provider_connection_invalid'
    END;

    -- Match the shared child-table lock order used by membership and lifecycle
    -- retirement. The management path locks affected workspace rows before it
    -- changes the connection, preventing an access/setup publication race.
    UPDATE cloud_workspace_client_access_grants access
    SET state = 'revocation_pending',
        revocation_reason = retirement_reason,
        next_revocation_at = now(), updated_at = now()
    FROM cloud_workspace_generations generation
    WHERE generation.workspace_id = access.workspace_id
      AND generation.generation = access.generation
      AND generation.org_id = access.org_id
      AND generation.provider_connection_id = NEW.id
      AND access.state IN ('issuing', 'active');

    UPDATE cloud_workspace_endpoint_grants grant_row
    SET revoked_at = coalesce(grant_row.revoked_at, now())
    FROM cloud_workspace_generations generation
    WHERE generation.workspace_id = grant_row.workspace_id
      AND generation.generation = grant_row.generation
      AND generation.org_id = grant_row.org_id
      AND generation.provider_connection_id = NEW.id
      AND grant_row.revoked_at IS NULL;

    UPDATE cloud_workspace_setup_runs setup
    SET state = 'cancelled', completed_at = now(),
        lease_owner = NULL, lease_expires_at = NULL,
        error_code = retirement_reason, updated_at = now()
    FROM cloud_workspace_generations generation
    WHERE generation.workspace_id = setup.workspace_id
      AND generation.generation = setup.generation
      AND generation.org_id = setup.org_id
      AND generation.provider_connection_id = NEW.id
      AND setup.state IN ('queued', 'running');

    UPDATE cloud_workspace_engine_instances engine
    SET state = 'revoked', revoked_at = coalesce(engine.revoked_at, now()),
        updated_at = now()
    FROM cloud_workspace_generations generation
    WHERE generation.workspace_id = engine.workspace_id
      AND generation.generation = engine.generation
      AND generation.org_id = engine.org_id
      AND generation.provider_connection_id = NEW.id
      AND engine.state IN ('starting', 'ready');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_connection_authority_retirement
  AFTER UPDATE OF state ON provider_connections
  FOR EACH ROW
  WHEN (OLD.state = 'active' AND NEW.state IN ('revoked', 'invalid'))
  EXECUTE FUNCTION retire_cloud_workspace_provider_connection_authority();

REVOKE ALL ON FUNCTION retire_cloud_workspace_provider_connection_authority()
  FROM PUBLIC;
