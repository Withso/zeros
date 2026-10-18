-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Lifecycle due work moves from a repeated six-branch scan onto
-- control_plane_jobs (0148). Every writer of a lifecycle deadline enqueues a
-- job for its (kind, workspace) in the same transaction, so the deadline and
-- its wake-up commit together. Triggers rather than TypeScript enqueues: they
-- cover every writer, including stored functions and operator repairs.
--
-- run_at is a lower bound of the true due time, never later. A job that runs
-- early re-reads its workspace, does nothing and reschedules itself at the
-- exact due time; a job is never needed later than its run_at. Jobs carry no
-- authority: handlers claim through the existing fenced transactions.
--
-- Every source table is written only in system transactions (their RLS
-- policies require app_is_system()), so these INVOKER functions satisfy the
-- queue's system_only policy without SECURITY DEFINER. Older replicas ignore
-- the jobs and keep their own polling; the 0134/0143 hints are unchanged.

-- Earliest wins, exactly like enqueueJob: a queued job only moves earlier and
-- a running job records one more run. A domain write resets the handler's
-- empty-run backoff, which it keeps in the payload.
CREATE FUNCTION enqueue_cloud_lifecycle_job(job_kind text, scope_workspace_id uuid, scope_org_id uuid, due_at timestamptz)
RETURNS void LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS $$
  INSERT INTO control_plane_jobs AS job (kind, dedupe_key, org_id, workspace_id, run_at)
  SELECT job_kind, CASE WHEN scope_workspace_id IS NULL THEN 'singleton' ELSE 'workspace:' || scope_workspace_id::text END,
    scope_org_id, scope_workspace_id, coalesce(due_at, now())
  WHERE job_kind IN ('cloud_lifecycle_intent','cloud_paid_authority_check','cloud_engine_health',
    'cloud_compute_lease','cloud_workspace_drift','cloud_diagnostic_cleanup')
  ON CONFLICT (kind, dedupe_key) WHERE state IN ('queued','running') DO UPDATE SET
    payload = '{}'::jsonb,
    run_at = CASE WHEN job.state = 'queued' THEN least(job.run_at, EXCLUDED.run_at) ELSE job.run_at END,
    rerun_at = CASE WHEN job.state = 'running' THEN least(job.rerun_at, EXCLUDED.run_at) END,
    updated_at = clock_timestamp()
  WHERE job.payload <> '{}'::jsonb
    OR (job.state = 'queued' AND EXCLUDED.run_at < job.run_at)
    OR (job.state = 'running' AND (job.rerun_at IS NULL OR EXCLUDED.run_at < job.rerun_at))
$$;

-- An active intent is due no earlier than its next attempt or, while
-- dispatching, its lease. Leaving the active states can admit a dependent or
-- queued intent and lifts the engine-health and drift exclusions.
CREATE FUNCTION cloud_lifecycle_intent_jobs() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state IN ('queued','observing','dispatching') THEN
    PERFORM enqueue_cloud_lifecycle_job('cloud_lifecycle_intent', NEW.workspace_id, NEW.org_id,
      CASE WHEN NEW.state = 'dispatching' THEN greatest(NEW.next_attempt_at, NEW.lease_expires_at) ELSE NEW.next_attempt_at END);
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.state IS DISTINCT FROM NEW.state THEN
      PERFORM enqueue_cloud_lifecycle_job('cloud_lifecycle_intent', NEW.workspace_id, NEW.org_id, now());
      PERFORM enqueue_cloud_lifecycle_job('cloud_engine_health', NEW.workspace_id, NEW.org_id, now());
      PERFORM enqueue_cloud_lifecycle_job('cloud_workspace_drift', NEW.workspace_id, NEW.org_id, now());
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_lifecycle_intent_jobs
  AFTER INSERT OR UPDATE OF state, next_attempt_at, lease_expires_at ON cloud_workspace_lifecycle_intents
  FOR EACH ROW EXECUTE FUNCTION cloud_lifecycle_intent_jobs();

-- A settled checkpoint request or local-to-cloud import can admit an intent.
CREATE FUNCTION cloud_lifecycle_admission_jobs() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'workspace_checkpoint_requests' THEN
    PERFORM enqueue_cloud_lifecycle_job('cloud_lifecycle_intent', NEW.workspace_id, NEW.org_id, now());
  ELSIF NEW.target_cloud_workspace_id IS NOT NULL THEN
    PERFORM enqueue_cloud_lifecycle_job('cloud_lifecycle_intent', NEW.target_cloud_workspace_id, NEW.org_id, now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_lifecycle_checkpoint_jobs
  AFTER UPDATE OF state ON workspace_checkpoint_requests
  FOR EACH ROW WHEN (NEW.lifecycle_intent_id IS NOT NULL AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION cloud_lifecycle_admission_jobs();
CREATE TRIGGER cloud_lifecycle_fork_jobs
  AFTER UPDATE OF state ON workspace_fork_intents
  FOR EACH ROW WHEN (NEW.operation = 'local_to_cloud' AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION cloud_lifecycle_admission_jobs();

CREATE FUNCTION cloud_paid_authority_jobs() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM enqueue_cloud_lifecycle_job('cloud_paid_authority_check', NEW.workspace_id, NEW.org_id, NEW.next_check_at);
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_paid_authority_jobs
  AFTER INSERT OR UPDATE OF next_check_at ON cloud_workspace_paid_authority_checks
  FOR EACH ROW WHEN (NEW.next_check_at IS NOT NULL)
  EXECUTE FUNCTION cloud_paid_authority_jobs();

-- Renewals only move the engine deadline later: the job runs at the earlier
-- expiry, sees the renewal and reschedules itself, so heartbeats write
-- nothing here. Enrollment, revocation and a shortened lease wake it now.
CREATE FUNCTION cloud_engine_health_jobs() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM enqueue_cloud_lifecycle_job('cloud_engine_health', NEW.workspace_id, NEW.org_id, now());
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_engine_health_enrolled_jobs
  AFTER INSERT ON cloud_workspace_engine_instances
  FOR EACH ROW EXECUTE FUNCTION cloud_engine_health_jobs();
CREATE TRIGGER cloud_engine_health_changed_jobs
  AFTER UPDATE OF state, revoked_at, lease_expires_at ON cloud_workspace_engine_instances
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
    OR NEW.lease_expires_at < OLD.lease_expires_at)
  EXECUTE FUNCTION cloud_engine_health_jobs();

-- A workspace that becomes running and ready (or busy) starts engine-health
-- tracking; ready/busy flips do not. A new diagnostic recovery watermark can
-- make unrecovered incidents publishable.
CREATE FUNCTION cloud_workspace_lifecycle_jobs() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  eligible boolean := NEW.desired_state = 'running' AND NEW.status IN ('ready','busy') AND NEW.deleted_at IS NULL;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF eligible THEN
      PERFORM enqueue_cloud_lifecycle_job('cloud_engine_health', NEW.id, NEW.org_id, now());
    END IF;
    RETURN NEW;
  END IF;
  IF eligible AND (NOT (OLD.desired_state = 'running' AND OLD.status IN ('ready','busy') AND OLD.deleted_at IS NULL)
    OR OLD.current_generation IS DISTINCT FROM NEW.current_generation) THEN
    PERFORM enqueue_cloud_lifecycle_job('cloud_engine_health', NEW.id, NEW.org_id, now());
  END IF;
  IF OLD.diagnostic_recovery_at IS DISTINCT FROM NEW.diagnostic_recovery_at
    OR OLD.diagnostic_recovery_generation IS DISTINCT FROM NEW.diagnostic_recovery_generation THEN
    PERFORM enqueue_cloud_lifecycle_job('cloud_diagnostic_cleanup', NULL, NULL, now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_workspace_lifecycle_jobs
  AFTER INSERT OR UPDATE OF status, desired_state, current_generation, deleted_at,
    diagnostic_recovery_at, diagnostic_recovery_generation ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION cloud_workspace_lifecycle_jobs();

CREATE FUNCTION cloud_compute_lease_jobs() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM enqueue_cloud_lifecycle_job('cloud_compute_lease', NEW.workspace_id, NEW.org_id,
    greatest(NEW.next_check_at, CASE WHEN NEW.lease_owner IS NOT NULL THEN NEW.lease_expires_at END));
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_compute_lease_jobs
  AFTER INSERT OR UPDATE OF state, next_check_at, lease_owner, lease_expires_at ON managed_compute_allocation_leases
  FOR EACH ROW WHEN (NEW.state <> 'settled')
  EXECUTE FUNCTION cloud_compute_lease_jobs();

-- An active runtime transition defers its workspace's compute lease; ending it
-- early must not leave the lease waiting for the old deadline.
CREATE FUNCTION cloud_runtime_transition_jobs() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM managed_compute_allocation_leases lease
    WHERE lease.workspace_id = NEW.workspace_id AND lease.state <> 'settled') THEN
    PERFORM enqueue_cloud_lifecycle_job('cloud_compute_lease', NEW.workspace_id, NEW.org_id, now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_runtime_transition_jobs
  AFTER INSERT OR UPDATE OF phase, activation_deadline_at, rollback_deadline_at ON cloud_workspace_runtime_transitions
  FOR EACH ROW EXECUTE FUNCTION cloud_runtime_transition_jobs();

CREATE FUNCTION cloud_drift_binding_jobs() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM enqueue_cloud_lifecycle_job('cloud_workspace_drift', NEW.workspace_id, NEW.org_id, NEW.next_drift_check_at);
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_drift_binding_jobs
  AFTER INSERT OR UPDATE OF next_drift_check_at ON cloud_workspace_provider_bindings
  FOR EACH ROW EXECUTE FUNCTION cloud_drift_binding_jobs();

-- An active restore incident excludes its workspace from drift checks.
CREATE FUNCTION cloud_drift_restore_jobs() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM enqueue_cloud_lifecycle_job('cloud_workspace_drift', NEW.workspace_id, NEW.org_id, now());
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_drift_restore_jobs
  AFTER UPDATE OF state ON cloud_workspace_restore_incidents
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION cloud_drift_restore_jobs();

CREATE FUNCTION cloud_diagnostic_cleanup_jobs() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'cloud_workspace_diagnostic_cleanup' THEN
    PERFORM enqueue_cloud_lifecycle_job('cloud_diagnostic_cleanup', NULL, NULL, NEW.next_run_at);
  ELSIF EXISTS (SELECT 1 FROM cloud_workspaces workspace WHERE workspace.id = NEW.workspace_id
    AND workspace.org_id = NEW.org_id AND NEW.last_at <= workspace.diagnostic_recovery_at
    AND NEW.generation <= workspace.diagnostic_recovery_generation) THEN
    PERFORM enqueue_cloud_lifecycle_job('cloud_diagnostic_cleanup', NULL, NULL, now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_diagnostic_cleanup_jobs
  AFTER INSERT OR UPDATE OF next_run_at ON cloud_workspace_diagnostic_cleanup
  FOR EACH ROW WHEN (NEW.id) EXECUTE FUNCTION cloud_diagnostic_cleanup_jobs();
CREATE TRIGGER cloud_diagnostic_incident_jobs
  AFTER INSERT OR UPDATE OF last_at, generation, recovered_at ON cloud_workspace_diagnostic_incidents
  FOR EACH ROW WHEN (NEW.recovered_at IS NULL) EXECUTE FUNCTION cloud_diagnostic_cleanup_jobs();

-- Backfill: every row that can carry a deadline gets a job now. Each runs
-- once after deploy and reschedules itself at its exact due time.
SELECT set_config('app.system', 'on', true);
SELECT enqueue_cloud_lifecycle_job('cloud_lifecycle_intent', workspace_id, org_id, now())
  FROM (SELECT DISTINCT workspace_id, org_id FROM cloud_workspace_lifecycle_intents
    WHERE state IN ('queued','observing','dispatching')) intent;
SELECT enqueue_cloud_lifecycle_job('cloud_paid_authority_check', workspace_id, org_id, next_check_at)
  FROM cloud_workspace_paid_authority_checks WHERE next_check_at IS NOT NULL;
SELECT enqueue_cloud_lifecycle_job('cloud_engine_health', id, org_id, now())
  FROM cloud_workspaces WHERE desired_state = 'running' AND status IN ('ready','busy') AND deleted_at IS NULL;
SELECT enqueue_cloud_lifecycle_job('cloud_compute_lease', workspace_id, org_id, now())
  FROM (SELECT DISTINCT workspace_id, org_id FROM managed_compute_allocation_leases WHERE state <> 'settled') lease;
SELECT enqueue_cloud_lifecycle_job('cloud_workspace_drift', workspace.id, workspace.org_id, binding.next_drift_check_at)
  FROM cloud_workspaces workspace JOIN cloud_workspace_provider_bindings binding
    ON binding.workspace_id = workspace.id AND binding.generation = workspace.current_generation
  WHERE workspace.status <> 'deleted';
-- A fresh database must migrate to identical rows apart from timestamps (the
-- reusable test baseline compares two replays), so this one-time seed of the
-- singleton carries a fixed id instead of the column's random default.
INSERT INTO control_plane_jobs (id, kind, dedupe_key, run_at)
VALUES ('00000000-0000-4000-8000-000000000150', 'cloud_diagnostic_cleanup', 'singleton', now())
ON CONFLICT (kind, dedupe_key) WHERE state IN ('queued','running') DO NOTHING;
SELECT set_config('app.system', '', true);
