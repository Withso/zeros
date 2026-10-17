-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Inventory pacing gets its own column instead of pushing
-- next_drift_check_at out. next_drift_check_at stays the per-interval drift
-- schedule and the drift claim lease, so a replica that predates pacing (or
-- a binary rolled back to one) ignores these columns and keeps checking
-- every interval instead of finding every listed binding hours away.
--
-- drift_paced_until: a sweep that listed the resource in its steady,
-- desired state defers drift inspects until then. NULL means unpaced.
-- drift_inspect_requested: a lifecycle event (an intent leaving the active
-- states, a restore incident changing state, an inventory re-bind) asked for
-- an inspect. A sweep does not pace a requested binding, so a sweep that read
-- its rows before the event committed cannot re-pace it; the next drift
-- observation clears the request.
ALTER TABLE cloud_workspace_provider_bindings
  ADD COLUMN drift_paced_until timestamptz,
  ADD COLUMN drift_inspect_requested boolean NOT NULL DEFAULT false;

-- Both columns are drift bookkeeping the authority predicate never reads, so
-- pacing and inspect requests must not invalidate cached authority: 0152's
-- trigger function with the two columns added to the binding exemption.
-- Writes that change neither column notify exactly as under 0152.
-- zeros-expand-exception: authority-cache-exemption Adds only this migration's two drift bookkeeping columns to 0152's binding exemption.
CREATE OR REPLACE FUNCTION notify_cloud_authority_cache() RETURNS trigger
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
       AND (new_row - ARRAY['observed_state', 'observed_metadata', 'last_observed_at', 'next_drift_check_at',
                         'drift_paced_until', 'drift_inspect_requested', 'updated_at'])
         = (old_row - ARRAY['observed_state', 'observed_metadata', 'last_observed_at', 'next_drift_check_at',
                         'drift_paced_until', 'drift_inspect_requested', 'updated_at']) THEN
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

-- Lock order: callers hold the event row (intent or incident) and, by the
-- lifecycle convention, the workspace row; this then takes the binding, then
-- enqueue takes the job. Binding holders that skip the workspace lock (the
-- inventory sweep, the drift claim and its release) never wait on an intent
-- or incident row.
--
-- A schedule more than an hour out was written for a settled workspace (its
-- 6 h cadence or that cadence's failure backoff), a state the event may have
-- ended, so it is pulled in to now. Anything nearer may be a live drift claim
-- lease (the reconciler accepts leases of at most an hour), a provider
-- backoff or the per-interval cadence, and stays.
CREATE FUNCTION request_cloud_workspace_drift_inspect(scope_workspace_id uuid)
RETURNS void LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS $$
  UPDATE cloud_workspace_provider_bindings binding
  SET drift_inspect_requested = true, drift_paced_until = NULL,
      next_drift_check_at = CASE WHEN binding.next_drift_check_at > now() + interval '1 hour'
        THEN now() ELSE binding.next_drift_check_at END
  FROM cloud_workspaces workspace
  WHERE workspace.id = scope_workspace_id
    AND binding.workspace_id = workspace.id
    AND binding.generation = workspace.current_generation
    AND (NOT binding.drift_inspect_requested OR binding.next_drift_check_at > now() + interval '1 hour')
$$;

-- The events whose 0150 triggers enqueue the drift job (an intent leaving the
-- active states, a restore incident changing state) also request the
-- inspect. PostgreSQL fires a table's triggers in name order, and these names
-- sort before 0150's cloud_lifecycle_intent_jobs and cloud_drift_restore_jobs,
-- so the event locks the binding before any job row, as the drift claim does.
CREATE FUNCTION cloud_drift_inspect_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM request_cloud_workspace_drift_inspect(NEW.workspace_id);
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_lifecycle_intent_drift_inspect
  AFTER UPDATE OF state ON cloud_workspace_lifecycle_intents
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state NOT IN ('queued','observing','dispatching'))
  EXECUTE FUNCTION cloud_drift_inspect_request();
CREATE TRIGGER cloud_drift_restore_inspect
  AFTER UPDATE OF state ON cloud_workspace_restore_incidents
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION cloud_drift_inspect_request();
