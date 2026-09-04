-- ───────────────────────────────────────────────────────────
-- 0044 — current managed-policy authority
--
-- Organization policy is a live security boundary. A generation keeps its
-- immutable settings snapshot for reproducibility, but it may execute only
-- while that snapshot names the organization's current policy head. Cleanup
-- remains generation-addressable outside this predicate so a stale sandbox
-- can always be stopped or deleted.
-- ───────────────────────────────────────────────────────────

CREATE FUNCTION cloud_workspace_generation_policy_current(
  target_workspace_id uuid,
  target_generation integer,
  target_org_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM workspace_settings_versions settings
    LEFT JOIN organization_cloud_policy_heads policy
      ON policy.org_id = settings.org_id
    WHERE settings.workspace_id = target_workspace_id
      AND settings.generation = target_generation
      AND settings.org_id = target_org_id
      AND settings.managed_policy_version
            IS NOT DISTINCT FROM policy.current_version
  )
$$;
REVOKE ALL ON FUNCTION cloud_workspace_generation_policy_current(
  uuid, integer, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_generation_policy_current(
  uuid, integer, uuid
) TO zeros_app;

CREATE FUNCTION retire_cloud_workspace_managed_policy_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR OLD.current_version IS DISTINCT FROM NEW.current_version THEN
    UPDATE cloud_workspace_client_access_grants access
    SET state = 'revocation_pending',
        revocation_reason = 'managed_policy_changed',
        next_revocation_at = now(), updated_at = now()
    FROM workspace_settings_versions settings
    WHERE settings.workspace_id = access.workspace_id
      AND settings.generation = access.generation
      AND settings.org_id = access.org_id
      AND settings.org_id = NEW.org_id
      AND settings.managed_policy_version IS DISTINCT FROM NEW.current_version
      AND access.state IN ('issuing', 'active');

    UPDATE cloud_workspace_endpoint_grants grant_row
    SET revoked_at = coalesce(grant_row.revoked_at, now())
    FROM workspace_settings_versions settings
    WHERE settings.workspace_id = grant_row.workspace_id
      AND settings.generation = grant_row.generation
      AND settings.org_id = grant_row.org_id
      AND settings.org_id = NEW.org_id
      AND settings.managed_policy_version IS DISTINCT FROM NEW.current_version
      AND grant_row.revoked_at IS NULL;

    UPDATE cloud_workspace_setup_runs setup
    SET state = 'cancelled', completed_at = now(),
        lease_owner = NULL, lease_expires_at = NULL,
        error_code = 'managed_policy_changed', updated_at = now()
    FROM workspace_settings_versions settings
    WHERE settings.workspace_id = setup.workspace_id
      AND settings.generation = setup.generation
      AND settings.org_id = setup.org_id
      AND settings.org_id = NEW.org_id
      AND settings.managed_policy_version IS DISTINCT FROM NEW.current_version
      AND setup.state IN ('queued', 'running');

    UPDATE cloud_workspace_engine_instances engine
    SET state = 'revoked', revoked_at = coalesce(engine.revoked_at, now()),
        updated_at = now()
    FROM workspace_settings_versions settings
    WHERE settings.workspace_id = engine.workspace_id
      AND settings.generation = engine.generation
      AND settings.org_id = engine.org_id
      AND settings.org_id = NEW.org_id
      AND settings.managed_policy_version IS DISTINCT FROM NEW.current_version
      AND engine.state IN ('starting', 'ready');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER managed_policy_authority_retirement
  AFTER INSERT OR UPDATE OF current_version
  ON organization_cloud_policy_heads
  FOR EACH ROW
  EXECUTE FUNCTION retire_cloud_workspace_managed_policy_authority();

REVOKE ALL ON FUNCTION retire_cloud_workspace_managed_policy_authority()
  FROM PUBLIC;
