-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Commit-bound invalidation hints for the in-process engine authority cache
-- (apps/control-plane/src/cloud-workspaces/engine-authority-cache.ts). Every
-- table read by cloud_workspace_engine_authority_current, the functions it
-- calls and the cache loader carries this trigger; a test derives that table
-- set from the live function definitions, so a new input table without the
-- trigger fails CI. The payload names a scope only (w:<workspace>,
-- o:<organization>, u:<user> or *); listeners reload from SQL and never
-- trust values from the hint.
CREATE FUNCTION notify_cloud_authority_cache() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  scope text := TG_ARGV[0];
  old_row jsonb;
  new_row jsonb;
  old_key text;
  new_key text;
BEGIN
  IF scope = '*' THEN
    PERFORM pg_notify('zeros_cloud_authority_cache', '*');
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); old_key := old_row ->> TG_ARGV[1]; END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); new_key := new_row ->> TG_ARGV[1]; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF new_row = old_row THEN RETURN NULL; END IF;
    -- A heartbeat only extends the lease. Cached entries are bounded by the
    -- lease they loaded, so an extension can never keep a revoked engine
    -- live; a shortened lease or any other column change still notifies.
    IF TG_TABLE_NAME = 'cloud_workspace_engine_instances'
       AND (new_row - ARRAY['lease_expires_at', 'last_heartbeat_at', 'updated_at'])
         = (old_row - ARRAY['lease_expires_at', 'last_heartbeat_at', 'updated_at'])
       AND (old_row ->> 'lease_expires_at') IS NOT NULL
       AND (new_row ->> 'lease_expires_at')::timestamptz >= (old_row ->> 'lease_expires_at')::timestamptz THEN
      RETURN NULL;
    END IF;
    -- Lease renewals only extend funded_until/provider_expires_at. A cached
    -- entry is bounded by the deadline it loaded, so an extension can never
    -- keep a stopped workspace live; a shortened deadline or any other
    -- column change still notifies.
    IF TG_TABLE_NAME = 'managed_compute_allocation_leases'
       AND (new_row - ARRAY['funded_until', 'provider_expires_at', 'updated_at'])
         = (old_row - ARRAY['funded_until', 'provider_expires_at', 'updated_at'])
       AND (old_row ->> 'funded_until') IS NOT NULL
       AND (new_row ->> 'funded_until')::timestamptz >= (old_row ->> 'funded_until')::timestamptz
       AND (old_row ->> 'provider_expires_at') IS NOT NULL
       AND (new_row ->> 'provider_expires_at')::timestamptz >= (old_row ->> 'provider_expires_at')::timestamptz THEN
      RETURN NULL;
    END IF;
    -- Credit top-ups and usage metering move money columns and extend
    -- covered_until. Of these the authority predicate reads covered_until
    -- (a deadline the entry is bounded by) and reserved_micro_usd > 0, so the
    -- write is skipped only while covered_until moves later and the
    -- reservation stays funded. A state change, a shortened covered_until or
    -- an exhausted reservation still notifies.
    IF TG_TABLE_NAME = 'managed_compute_credit_reservations'
       AND (new_row - ARRAY['covered_until', 'meter_through', 'authorized_micro_usd', 'reserved_micro_usd', 'actual_micro_usd', 'debited_micro_usd', 'exposure_micro_usd', 'billable_seconds', 'updated_at'])
         = (old_row - ARRAY['covered_until', 'meter_through', 'authorized_micro_usd', 'reserved_micro_usd', 'actual_micro_usd', 'debited_micro_usd', 'exposure_micro_usd', 'billable_seconds', 'updated_at'])
       AND (new_row ->> 'covered_until')::timestamptz >= (old_row ->> 'covered_until')::timestamptz
       AND ((new_row ->> 'reserved_micro_usd')::numeric > 0) = ((old_row ->> 'reserved_micro_usd')::numeric > 0) THEN
      RETURN NULL;
    END IF;
    -- A heartbeat carrying a port scan stamps ports_observed_at (UI
    -- metadata, unread by the predicate). Notifying here would cost one
    -- notifying commit per active workspace every heartbeat and flush the
    -- workspace's entries each time.
    IF TG_TABLE_NAME = 'cloud_workspace_generations'
       AND (new_row - ARRAY['ports_observed_at']) = (old_row - ARRAY['ports_observed_at']) THEN
      RETURN NULL;
    END IF;
    -- Drift bookkeeping columns on provider bindings are not read by the
    -- authority predicate, so sweep writes never invalidate.
    IF TG_TABLE_NAME = 'cloud_workspace_provider_bindings'
       AND (new_row - ARRAY['observed_state', 'observed_metadata', 'last_observed_at', 'next_drift_check_at', 'updated_at'])
         = (old_row - ARRAY['observed_state', 'observed_metadata', 'last_observed_at', 'next_drift_check_at', 'updated_at']) THEN
      RETURN NULL;
    END IF;
  END IF;
  IF old_key IS NULL AND new_key IS NULL THEN
    PERFORM pg_notify('zeros_cloud_authority_cache', '*');
    RETURN NULL;
  END IF;
  IF old_key IS NOT NULL THEN
    PERFORM pg_notify('zeros_cloud_authority_cache', scope || ':' || old_key);
  END IF;
  IF new_key IS NOT NULL AND new_key IS DISTINCT FROM old_key THEN
    PERFORM pg_notify('zeros_cloud_authority_cache', scope || ':' || new_key);
  END IF;
  RETURN NULL;
END $$;

-- Workspace-scoped inputs.
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('w', 'id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON cloud_workspace_engine_instances
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('w', 'workspace_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON cloud_workspace_members
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('w', 'workspace_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON workspace_billing_epochs
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('w', 'workspace_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON workspace_settings_versions
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('w', 'workspace_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON cloud_workspace_generations
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('w', 'workspace_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON managed_compute_allocation_leases
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('w', 'workspace_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON managed_compute_credit_reservations
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('w', 'workspace_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON cloud_workspace_allocation_owners
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('w', 'workspace_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON cloud_workspace_provider_bindings
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('w', 'workspace_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON cloud_workspace_restore_incidents
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('w', 'workspace_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON cloud_workspace_generation_transitions
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('w', 'workspace_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON cloud_workspace_runtime_enrollments
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('w', 'workspace_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON cloud_workspace_runtime_transitions
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('w', 'workspace_id');

-- Organization-scoped inputs.
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON organizations
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('o', 'id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('o', 'org_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON teams
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('o', 'org_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON team_members
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('o', 'org_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON organization_entitlements
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('o', 'org_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON organization_seat_assignments
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('o', 'org_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON organization_cloud_policy_heads
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('o', 'org_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON workos_organization_links
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('o', 'organization_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON provider_connections
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('o', 'org_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON provider_connection_versions
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('o', 'org_id');

-- User-scoped inputs.
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('u', 'id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON account_entitlements
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('u', 'user_id');
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON staff_pro_benefits
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('u', 'user_id');

-- Global input: one provider requirement row applies to every workspace.
CREATE TRIGGER zz_cloud_authority_cache AFTER INSERT OR UPDATE OR DELETE ON managed_compute_provider_requirements
  FOR EACH ROW EXECUTE FUNCTION notify_cloud_authority_cache('*');

-- The cache loader's read. cloud_workspace_engine_authority_current(...,
-- false) takes FOR SHARE on the organization, workspace and engine rows,
-- which writes row locks on a read path and makes every heartbeat UPDATE of
-- the engine row wait for a concurrent load. This is the same body with
-- only the row locks removed (engine-authority-cache.integration.test.ts
-- pins that derivation), so the cache still evaluates the exact predicate.
-- A load racing a commit is covered by the load-discard rule and the hint
-- that commit sends, not by row locks.
CREATE FUNCTION cloud_workspace_engine_authority_snapshot(
  target_workspace_id uuid, target_org_id uuid, target_generation integer,
  target_engine_id uuid, require_workos boolean
) RETURNS TABLE (
  authority_epoch bigint, account_user_id uuid, heartbeat_token_hash bytea,
  live boolean, fenced boolean
) LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  workspace record;
  engine record;
  found_rows integer;
BEGIN
  SELECT w.current_generation, w.authority_epoch, w.desired_state, w.status
    FROM cloud_workspaces w
    WHERE w.id = target_workspace_id AND w.org_id = target_org_id AND w.deleted_at IS NULL
      AND cloud_workspace_generation_policy_current(w.id, target_generation, w.org_id)
  INTO workspace;
  GET DIAGNOSTICS found_rows = ROW_COUNT;
  IF found_rows <> 1 OR workspace.current_generation <> target_generation
    OR workspace.desired_state <> 'running' OR workspace.status NOT IN ('setting_up', 'ready', 'busy') THEN
    RETURN;
  END IF;
  SELECT instance.account_user_id, instance.heartbeat_token_hash
    FROM cloud_workspace_engine_instances instance
    WHERE instance.id = target_engine_id AND instance.workspace_id = target_workspace_id AND instance.org_id = target_org_id
      AND instance.generation = target_generation AND instance.state = 'ready'
      AND instance.lease_expires_at > clock_timestamp()
      AND cloud_workspace_runtime_authority_live(
        instance.workspace_id, instance.generation, instance.account_user_id, require_workos)
  INTO engine;
  GET DIAGNOSTICS found_rows = ROW_COUNT;
  IF found_rows <> 1 THEN
    RETURN;
  END IF;
  -- SELECT ... FOR UPDATE may evaluate its predicate before waiting. Recheck
  -- the deadlines once both scope and engine locks are actually held.
  RETURN QUERY SELECT workspace.authority_epoch::bigint, engine.account_user_id, engine.heartbeat_token_hash,
    EXISTS (
      SELECT 1 FROM cloud_workspace_engine_instances instance
      WHERE instance.id = target_engine_id AND instance.lease_expires_at > clock_timestamp()
        AND cloud_workspace_runtime_authority_live(
          instance.workspace_id, instance.generation, instance.account_user_id, require_workos)
    ),
    EXISTS (
      SELECT 1 FROM cloud_workspace_engine_instances instance
      WHERE instance.id = target_engine_id AND instance.final_checkpoint_at IS NOT NULL
    );
END
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION cloud_workspace_engine_authority_snapshot(uuid, uuid, integer, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_engine_authority_snapshot(uuid, uuid, integer, uuid, boolean) TO zeros_app;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION notify_cloud_authority_cache() FROM PUBLIC;
