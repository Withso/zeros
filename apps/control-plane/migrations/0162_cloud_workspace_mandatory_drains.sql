-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Settled leases remain evidence for an unfinished source drain. Bound that
-- exact lookup without scanning all historical allocations on each wake.
CREATE INDEX managed_compute_mandatory_stop_idx
  ON managed_compute_allocation_leases(stop_intent_id)
  WHERE stop_intent_id IS NOT NULL AND state IN ('draining','settled');

-- A compute safety decision, a committed final capture, or a dependent wake
-- makes the exact stop irrevocable. Cancelling capture is not cancelling that
-- decision. Use the existing durable references, including older writers.
CREATE FUNCTION cloud_workspace_drain_is_mandatory(target_intent_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM cloud_workspace_lifecycle_intents drain
    WHERE drain.id=target_intent_id AND drain.operation IN ('stop','archive') AND (
      EXISTS (SELECT 1 FROM managed_compute_allocation_leases lease
        WHERE lease.workspace_id=drain.workspace_id AND lease.org_id=drain.org_id
          AND lease.stop_intent_id=drain.id AND lease.state IN ('draining','settled'))
      OR EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents wake
        WHERE wake.workspace_id=drain.workspace_id AND wake.org_id=drain.org_id
          AND wake.generation=drain.generation AND wake.operation='wake' AND wake.resume_after_intent_id=drain.id)
      OR EXISTS (SELECT 1 FROM workspace_checkpoint_requests proof
        WHERE proof.lifecycle_intent_id=drain.id AND proof.state='succeeded'
          AND proof.reason IN ('before_stop','before_archive')
          AND NOT EXISTS (SELECT 1 FROM cloud_workspace_engine_instances engine
            WHERE engine.workspace_id=proof.workspace_id AND engine.org_id=proof.org_id
              AND engine.generation=proof.generation AND engine.created_at>proof.completed_at))
    )
  );
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION cloud_workspace_drain_is_mandatory(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_drain_is_mandatory(uuid) TO zeros_app;

-- A cancelled mandatory capture still owns a deadline. Mark that small work
-- set explicitly so the deadline worker does not scan historical cancellations.
CREATE FUNCTION cloud_workspace_preserve_capture_deadline() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.state='cancelled' AND NEW.error_code IN ('workspace_active','superseded_by_newer_intent')
    AND cloud_workspace_drain_is_mandatory(NEW.lifecycle_intent_id) THEN
    NEW.error_code='mandatory_capture_cancelled';
  END IF;
  RETURN NEW;
END
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION cloud_workspace_preserve_capture_deadline() FROM PUBLIC;
CREATE TRIGGER cloud_workspace_preserve_capture_deadline BEFORE INSERT OR UPDATE OF state
  ON workspace_checkpoint_requests FOR EACH ROW EXECUTE FUNCTION cloud_workspace_preserve_capture_deadline();
CREATE INDEX workspace_checkpoint_requests_mandatory_deadline_idx
  ON workspace_checkpoint_requests(deadline_at,org_id,workspace_id)
  WHERE state='cancelled' AND error_code='mandatory_capture_cancelled';

-- Older cancellation and lifecycle writers must not erase a mandatory drain.
-- A stale provider response must be observed again; it is not retirement proof.
CREATE FUNCTION cloud_workspace_preserve_mandatory_drain() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.state='superseded' AND OLD.state IN ('queued','observing','dispatching')
    AND cloud_workspace_drain_is_mandatory(OLD.id) THEN
    NEW.state=CASE WHEN OLD.state='dispatching' THEN 'observing'::cloud_workspace_intent_state ELSE OLD.state END;
    NEW.affects_workspace=false;
    NEW.completed_at=NULL;
    NEW.next_attempt_at=OLD.next_attempt_at;
    NEW.error_code=OLD.error_code;
    NEW.error_message=OLD.error_message;
    NEW.lease_owner=NULL;
    NEW.lease_expires_at=NULL;
  END IF;
  RETURN NEW;
END
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION cloud_workspace_preserve_mandatory_drain() FROM PUBLIC;
CREATE TRIGGER cloud_workspace_preserve_mandatory_drain BEFORE UPDATE OF state
  ON cloud_workspace_lifecycle_intents FOR EACH ROW EXECUTE FUNCTION cloud_workspace_preserve_mandatory_drain();

-- An older warm-wake writer may call its receipt succeeded after trying to
-- supersede a safety stop. Preserve the wait as well as the original capture.
-- Failed drains are retried by current admission, never silently by this shim.
CREATE FUNCTION cloud_workspace_preserve_mandatory_wake() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE drain_id uuid;
BEGIN
  IF NEW.operation='wake' AND NEW.resume_after_intent_id IS NULL THEN
    SELECT drain.id INTO drain_id FROM cloud_workspace_lifecycle_intents drain
    WHERE drain.workspace_id=NEW.workspace_id AND drain.org_id=NEW.org_id AND drain.generation=NEW.generation
      AND drain.operation IN ('stop','archive') AND drain.state IN ('queued','observing','dispatching')
      AND cloud_workspace_drain_is_mandatory(drain.id)
    ORDER BY drain.created_at,drain.id LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      UPDATE cloud_workspace_lifecycle_intents SET affects_workspace=false WHERE id=drain_id;
      NEW.resume_after_intent_id=drain_id;
      NEW.state='queued'; NEW.completed_at=NULL;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION cloud_workspace_preserve_mandatory_wake() FROM PUBLIC;
CREATE TRIGGER cloud_workspace_preserve_mandatory_wake BEFORE INSERT
  ON cloud_workspace_lifecycle_intents FOR EACH ROW EXECUTE FUNCTION cloud_workspace_preserve_mandatory_wake();

-- The completed-drain trigger still fences explicit prerequisites and final
-- checkpoints. Also fence an omitted prerequisite for an unsealed old source:
-- an old worker can otherwise start the provider before current runOnce runs.
-- A source created by this wake's later setup is not its predecessor. Warm
-- no-op receipts never dispatch and are unaffected by this guard.
CREATE FUNCTION cloud_workspace_require_retired_wake_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.operation='wake' AND NEW.state='dispatching' AND (
    EXISTS (SELECT 1 FROM cloud_workspaces workspace JOIN cloud_agent_boot_bindings binding
      ON binding.id=workspace.agent_boot_id AND binding.workspace_id=workspace.id AND binding.org_id=workspace.org_id
      WHERE workspace.id=NEW.workspace_id AND workspace.org_id=NEW.org_id AND workspace.current_generation=NEW.generation
        AND binding.generation=NEW.generation AND binding.retired_at IS NULL AND binding.created_at<=NEW.created_at)
    OR EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents drain
      WHERE drain.workspace_id=NEW.workspace_id AND drain.org_id=NEW.org_id AND drain.generation=NEW.generation
        AND drain.operation IN ('stop','archive') AND drain.state IN ('queued','observing','dispatching')
        AND cloud_workspace_drain_is_mandatory(drain.id))
  ) THEN
    RAISE EXCEPTION 'workspace source retirement is not complete' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION cloud_workspace_require_retired_wake_source() FROM PUBLIC;
CREATE TRIGGER cloud_workspace_require_retired_wake_source BEFORE INSERT OR UPDATE OF state
  ON cloud_workspace_lifecycle_intents FOR EACH ROW EXECUTE FUNCTION cloud_workspace_require_retired_wake_source();
