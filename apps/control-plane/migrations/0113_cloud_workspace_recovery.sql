-- The migration owner is subject to FORCE RLS. Existing-row repairs need the
-- same transaction-local system context as migrations 0101-0104.
SELECT set_config('app.system','on',true);

-- A final checkpoint permanently closes the submitting engine epoch. New setup
-- creates a fresh engine; changing an intent must never reopen the old one.
ALTER TABLE cloud_workspace_engine_instances ADD COLUMN final_checkpoint_at timestamptz;
ALTER TABLE cloud_workspace_lifecycle_intents ADD COLUMN resume_after_intent_id uuid
  REFERENCES cloud_workspace_lifecycle_intents(id);

CREATE FUNCTION cloud_workspace_fence_final_checkpoint() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state = 'succeeded' AND NEW.reason IN ('before_stop','before_archive','before_delete','before_rebuild') THEN
    UPDATE cloud_workspace_engine_instances
    SET final_checkpoint_at = coalesce(final_checkpoint_at, NEW.completed_at)
    WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id AND generation=NEW.generation
      AND created_at <= NEW.completed_at;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cloud_workspace_fence_final_checkpoint() FROM PUBLIC;
CREATE TRIGGER cloud_workspace_fence_final_checkpoint
AFTER INSERT OR UPDATE OF state ON workspace_checkpoint_requests
FOR EACH ROW EXECUTE FUNCTION cloud_workspace_fence_final_checkpoint();
UPDATE cloud_workspace_engine_instances instance
SET final_checkpoint_at = proof.completed_at
FROM (
  SELECT workspace_id, org_id, generation, max(completed_at) AS completed_at
  FROM workspace_checkpoint_requests
  WHERE state='succeeded' AND reason IN ('before_stop','before_archive','before_delete','before_rebuild')
  GROUP BY workspace_id,org_id,generation
) proof
WHERE instance.workspace_id=proof.workspace_id AND instance.org_id=proof.org_id
  AND instance.generation=proof.generation AND instance.created_at<=proof.completed_at;

CREATE OR REPLACE FUNCTION cloud_workspace_engine_authority_current(
  target_workspace_id uuid, target_org_id uuid, target_generation integer,
  target_engine_id uuid, require_workos boolean, exclusive boolean
) RETURNS TABLE (
  authority_epoch bigint, account_user_id uuid, heartbeat_token_hash bytea,
  live boolean, fenced boolean
) LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  -- Only the lock strength varies between readers and mutators.
  strength text := CASE WHEN exclusive THEN 'UPDATE' ELSE 'SHARE' END;
  workspace record;
  engine record;
  found_rows integer;
BEGIN
  PERFORM 1 FROM organizations organization WHERE organization.id = target_org_id FOR SHARE;
  EXECUTE format($query$
    SELECT w.current_generation, w.authority_epoch, w.desired_state, w.status
    FROM cloud_workspaces w
    WHERE w.id = $1 AND w.org_id = $2 AND w.deleted_at IS NULL
      AND cloud_workspace_generation_policy_current(w.id, $3, w.org_id)
    FOR %s$query$, strength)
  INTO workspace USING target_workspace_id, target_org_id, target_generation;
  GET DIAGNOSTICS found_rows = ROW_COUNT;
  IF found_rows <> 1 OR workspace.current_generation <> target_generation
    OR workspace.desired_state <> 'running' OR workspace.status NOT IN ('setting_up', 'ready', 'busy') THEN
    RETURN;
  END IF;
  EXECUTE format($query$
    SELECT instance.account_user_id, instance.heartbeat_token_hash
    FROM cloud_workspace_engine_instances instance
    WHERE instance.id = $1 AND instance.workspace_id = $2 AND instance.org_id = $3
      AND instance.generation = $4 AND instance.state = 'ready'
      AND instance.lease_expires_at > clock_timestamp()
      AND cloud_workspace_runtime_authority_live(
        instance.workspace_id, instance.generation, instance.account_user_id, $5)
    FOR %s$query$, strength)
  INTO engine USING target_engine_id, target_workspace_id, target_org_id, target_generation, require_workos;
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

REVOKE ALL ON FUNCTION cloud_workspace_engine_authority_current(uuid, uuid, integer, uuid, boolean, boolean)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_engine_authority_current(uuid, uuid, integer, uuid, boolean, boolean)
  TO zeros_app;

-- One incident belongs to one failed wake. Retries and restarts cannot mint a
-- new candidate or reset its hourly budget. Data references remain pinned.
CREATE TABLE cloud_workspace_restore_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  source_generation integer NOT NULL,
  wake_intent_id uuid NOT NULL REFERENCES cloud_workspace_lifecycle_intents(id) ON DELETE CASCADE,
  setup_run_id uuid NOT NULL REFERENCES cloud_workspace_setup_runs(id) ON DELETE CASCADE,
  last_successful_setup_id uuid NOT NULL REFERENCES cloud_workspace_setup_attestations(setup_run_id) ON DELETE CASCADE,
  provider_resource_id text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  authority_epoch bigint NOT NULL,
  billing_epoch bigint NOT NULL,
  account_revision bigint NOT NULL,
  organization_revision bigint NOT NULL,
  membership_revision bigint NOT NULL,
  evidence_code text NOT NULL CHECK (evidence_code IN ('setup_immutable_runtime_missing','setup_immutable_inventory_invalid')),
  evidence_count integer NOT NULL DEFAULT 1 CHECK (evidence_count BETWEEN 1 AND 100),
  last_execution_fence bigint NOT NULL,
  checkpoint_id uuid REFERENCES workspace_checkpoints(id) ON DELETE SET NULL,
  checkpoint_digest bytea CHECK (checkpoint_digest IS NULL OR octet_length(checkpoint_digest)=32),
  content_revision bigint,
  record_revision bigint,
  checkpoint_at timestamptz,
  state text NOT NULL DEFAULT 'observing' CHECK (state IN ('observing','queued','waiting_for_capacity','waiting_for_funding','restoring','succeeded','recovery_needed','cancelled')),
  transition_id uuid REFERENCES cloud_workspace_generation_transitions(id) ON DELETE SET NULL,
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,127}$'),
  automatic_started_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL DEFAULT now()+interval '1 hour',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,source_generation,wake_intent_id),
  FOREIGN KEY(workspace_id,source_generation,org_id) REFERENCES cloud_workspace_generations(workspace_id,generation,org_id) ON DELETE CASCADE
);
CREATE INDEX cloud_workspace_restore_incidents_work_idx ON cloud_workspace_restore_incidents(next_attempt_at)
  WHERE state IN ('queued','waiting_for_capacity','waiting_for_funding','restoring');
CREATE INDEX cloud_workspace_restore_incidents_retention_idx ON cloud_workspace_restore_incidents(updated_at)
  WHERE state IN ('cancelled','succeeded');
ALTER TABLE cloud_workspace_restore_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_restore_incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_workspace_restore_incidents_system ON cloud_workspace_restore_incidents FOR ALL
  USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_workspace_restore_incidents TO zeros_app;

-- Old workers do not understand the new prerequisite column. Reject their
-- premature claim at the database boundary during rolling upgrades.
CREATE FUNCTION cloud_workspace_require_completed_drain() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.state='dispatching' AND NEW.resume_after_intent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cloud_workspace_lifecycle_intents prerequisite
    WHERE prerequisite.id=NEW.resume_after_intent_id AND prerequisite.workspace_id=NEW.workspace_id
      AND prerequisite.generation=NEW.generation AND prerequisite.org_id=NEW.org_id AND prerequisite.state='succeeded'
  ) THEN
    RAISE EXCEPTION 'workspace drain is not complete' USING ERRCODE='40001';
  END IF;
  -- Never trust a prerequisite supplied (or omitted) by an older writer.
  IF NEW.operation='wake' AND NEW.state='dispatching' AND EXISTS (
    SELECT 1 FROM workspace_checkpoint_requests request
    JOIN cloud_workspace_lifecycle_intents drain ON drain.id=request.lifecycle_intent_id
    WHERE request.workspace_id=NEW.workspace_id AND request.org_id=NEW.org_id AND request.generation=NEW.generation
      AND request.state='succeeded' AND request.reason IN ('before_stop','before_archive')
      AND drain.operation IN ('stop','archive') AND drain.state<>'succeeded'
      AND NOT EXISTS(SELECT 1 FROM cloud_workspace_engine_instances engine WHERE engine.workspace_id=request.workspace_id
        AND engine.generation=request.generation AND engine.created_at>request.completed_at)
  ) THEN
    RAISE EXCEPTION 'workspace drain is not complete' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cloud_workspace_require_completed_drain() FROM PUBLIC;
CREATE TRIGGER cloud_workspace_require_completed_drain BEFORE INSERT OR UPDATE OF state
  ON cloud_workspace_lifecycle_intents FOR EACH ROW EXECUTE FUNCTION cloud_workspace_require_completed_drain();
ALTER TABLE cloud_workspace_lifecycle_intents DROP CONSTRAINT cloud_workspace_lifecycle_intents_scope_check;
ALTER TABLE cloud_workspace_lifecycle_intents ADD CONSTRAINT cloud_workspace_lifecycle_intents_scope_check
  CHECK(affects_workspace OR operation IN ('stop','archive','delete'));

ALTER TABLE cloud_workspace_restore_incidents ADD COLUMN drain_intent_id uuid
  REFERENCES cloud_workspace_lifecycle_intents(id) ON DELETE SET NULL;

CREATE FUNCTION cloud_workspace_preserve_committed_drain() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof record;
BEGIN
  IF NEW.operation='wake' AND NEW.resume_after_intent_id IS NULL THEN
    SELECT intent.id,intent.state INTO proof
    FROM workspace_checkpoint_requests request JOIN cloud_workspace_lifecycle_intents intent ON intent.id=request.lifecycle_intent_id
    WHERE request.workspace_id=NEW.workspace_id AND request.org_id=NEW.org_id AND request.generation=NEW.generation
      AND request.state='succeeded' AND request.reason IN ('before_stop','before_archive')
      AND intent.operation IN ('stop','archive') AND intent.state IN ('queued','observing','dispatching','superseded','failed')
      AND NOT EXISTS(SELECT 1 FROM cloud_workspace_engine_instances engine WHERE engine.workspace_id=request.workspace_id
        AND engine.generation=request.generation AND engine.created_at>request.completed_at)
    ORDER BY request.completed_at DESC LIMIT 1 FOR UPDATE OF intent;
    IF FOUND THEN
      UPDATE cloud_workspace_lifecycle_intents SET affects_workspace=false,
        state=CASE WHEN state IN ('superseded','failed') THEN 'queued'::cloud_workspace_intent_state ELSE state END,
        next_attempt_at=CASE WHEN state IN ('superseded','failed') THEN now() ELSE next_attempt_at END,
        error_code=NULL,error_message=NULL,completed_at=NULL WHERE id=proof.id;
      NEW.resume_after_intent_id=proof.id;
      NEW.state='queued'; NEW.completed_at=NULL;
      UPDATE cloud_workspaces SET status='waking',desired_state='running',authority_epoch=authority_epoch+1,version=version+1,updated_at=now()
        WHERE id=NEW.workspace_id AND org_id=NEW.org_id;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cloud_workspace_preserve_committed_drain() FROM PUBLIC;
CREATE TRIGGER cloud_workspace_preserve_committed_drain BEFORE INSERT ON cloud_workspace_lifecycle_intents
  FOR EACH ROW EXECUTE FUNCTION cloud_workspace_preserve_committed_drain();

-- A previous backend may have captured affects_workspace=true before the
-- wake preserved its in-flight stop. Keep its response from stranding the
-- dependent wake. Only a fresh provider observation can complete that drain.
CREATE FUNCTION cloud_workspace_preserve_drain_response() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE stopped boolean;
BEGIN
  IF OLD.state='dispatching' AND NEW.state='superseded' AND NOT NEW.affects_workspace
    AND NEW.operation IN ('stop','archive')
    AND EXISTS(SELECT 1 FROM cloud_workspace_lifecycle_intents wake WHERE wake.resume_after_intent_id=NEW.id
      AND wake.state IN ('queued','observing'))
    AND EXISTS(SELECT 1 FROM workspace_checkpoint_requests proof WHERE proof.lifecycle_intent_id=NEW.id AND proof.state='succeeded') THEN
    SELECT EXISTS(SELECT 1 FROM cloud_workspace_provider_bindings binding
      WHERE binding.workspace_id=NEW.workspace_id AND binding.org_id=NEW.org_id AND binding.generation=NEW.generation
        AND binding.observed_state IN ('stopped','archived','deleted','absent') AND binding.last_observed_at>=OLD.updated_at)
      INTO stopped;
    NEW.state=CASE WHEN stopped THEN 'succeeded'::cloud_workspace_intent_state ELSE 'observing'::cloud_workspace_intent_state END;
    NEW.completed_at=CASE WHEN stopped THEN now() ELSE NULL END;
    NEW.lease_owner=NULL; NEW.lease_expires_at=NULL; NEW.next_attempt_at=now();
    NEW.error_code=NULL; NEW.error_message=NULL; NEW.updated_at=now();
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cloud_workspace_preserve_drain_response() FROM PUBLIC;
CREATE TRIGGER cloud_workspace_preserve_drain_response BEFORE UPDATE OF state ON cloud_workspace_lifecycle_intents
  FOR EACH ROW EXECUTE FUNCTION cloud_workspace_preserve_drain_response();

-- Previous reconcilers only fail the drain itself. Finish its dependent wakes
-- in the same transaction so an old claimant cannot select them forever and
-- a new claimant cannot leave them waiting on a permanently failed prerequisite.
CREATE FUNCTION cloud_workspace_fail_dependent_wakes() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.state='failed' AND NEW.operation IN ('stop','archive') THEN
    WITH failed_wakes AS (
      UPDATE cloud_workspace_lifecycle_intents wake
      SET state='failed',completed_at=now(),updated_at=now(),lease_owner=NULL,lease_expires_at=NULL,
        error_code='workspace_drain_failed',
        error_message='The previous engine could not be stopped. Retry starting the workspace.'
      WHERE wake.workspace_id=NEW.workspace_id AND wake.org_id=NEW.org_id AND wake.generation=NEW.generation
        AND wake.operation='wake' AND wake.affects_workspace AND wake.state IN ('queued','observing','dispatching')
        AND (wake.resume_after_intent_id=NEW.id OR (wake.resume_after_intent_id IS NULL AND EXISTS (
          -- Pre-migration wakes can lack an explicit prerequisite. Use the
          -- same committed-checkpoint proof as the independent dispatch fence.
          SELECT 1 FROM workspace_checkpoint_requests proof
          WHERE proof.lifecycle_intent_id=NEW.id AND proof.workspace_id=NEW.workspace_id
            AND proof.org_id=NEW.org_id AND proof.generation=NEW.generation
            AND proof.state='succeeded' AND proof.reason IN ('before_stop','before_archive')
            AND NOT EXISTS(SELECT 1 FROM cloud_workspace_engine_instances engine
              WHERE engine.workspace_id=proof.workspace_id AND engine.generation=proof.generation
                AND engine.created_at>proof.completed_at)
        )))
      RETURNING wake.id
    )
    UPDATE cloud_workspaces SET status='failed',last_error_code='workspace_drain_failed',
      last_error_message='The previous engine could not be stopped. Retry starting the workspace.',
      version=version+1,updated_at=now()
    WHERE id=NEW.workspace_id AND org_id=NEW.org_id AND current_generation=NEW.generation
      AND desired_state='running' AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM failed_wakes);
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cloud_workspace_fail_dependent_wakes() FROM PUBLIC;
CREATE TRIGGER cloud_workspace_fail_dependent_wakes AFTER INSERT OR UPDATE OF state
  ON cloud_workspace_lifecycle_intents FOR EACH ROW EXECUTE FUNCTION cloud_workspace_fail_dependent_wakes();

-- Repair wakes already stranded by a previous writer, including old rows
-- without the new prerequisite column populated. The trigger scopes the
-- failure to that generation and never replaces a later workspace intent.
UPDATE cloud_workspace_lifecycle_intents drain SET state=drain.state
WHERE drain.state='failed' AND drain.operation IN ('stop','archive')
  AND EXISTS(SELECT 1 FROM cloud_workspace_lifecycle_intents wake
    WHERE wake.workspace_id=drain.workspace_id AND wake.org_id=drain.org_id AND wake.generation=drain.generation
      AND wake.operation='wake' AND wake.affects_workspace AND wake.state IN ('queued','observing','dispatching')
      AND (wake.resume_after_intent_id=drain.id OR wake.resume_after_intent_id IS NULL));

-- Runtime admission alone is insufficient: old reconcilers allocate compute
-- and call provider start before engine admission. Fence those claims in SQL.
CREATE FUNCTION cloud_workspace_generation_quarantined(target_workspace_id uuid,target_generation integer,target_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM cloud_workspace_restore_incidents incident
    WHERE incident.workspace_id=target_workspace_id AND incident.org_id=target_org_id AND incident.source_generation=target_generation
      AND (incident.automatic_started_at IS NOT NULL OR incident.state='recovery_needed'))
    OR EXISTS(SELECT 1 FROM cloud_workspace_generation_transitions transition
      WHERE transition.workspace_id=target_workspace_id AND transition.org_id=target_org_id
        AND transition.source_generation=target_generation AND transition.operation='recover')
$$;
REVOKE ALL ON FUNCTION cloud_workspace_generation_quarantined(uuid,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_generation_quarantined(uuid,integer,uuid) TO zeros_app;

CREATE FUNCTION cloud_workspace_fence_quarantined_intent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.operation IN ('wake','create') AND cloud_workspace_generation_quarantined(NEW.workspace_id,NEW.generation,NEW.org_id) THEN
    IF NEW.state='dispatching' THEN
      RAISE EXCEPTION 'workspace generation is quarantined' USING ERRCODE='40001';
    END IF;
    IF NEW.state IN ('queued','observing','succeeded') THEN
      NEW.state='failed'; NEW.completed_at=now(); NEW.lease_owner=NULL; NEW.lease_expires_at=NULL;
      NEW.error_code='recovery_needed'; NEW.error_message='Recover this workspace from a saved checkpoint';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cloud_workspace_fence_quarantined_intent() FROM PUBLIC;
-- Run after the compatibility trigger that preserves a committed drain.
CREATE TRIGGER cloud_workspace_quarantine_intent BEFORE INSERT OR UPDATE OF state
  ON cloud_workspace_lifecycle_intents FOR EACH ROW EXECUTE FUNCTION cloud_workspace_fence_quarantined_intent();

CREATE FUNCTION cloud_workspace_fence_quarantined_workspace() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.status IN ('waking','provisioning','setting_up','ready','busy')
    AND cloud_workspace_generation_quarantined(NEW.id,NEW.current_generation,NEW.org_id) THEN
    NEW.desired_state='stopped'; NEW.status='failed';
    NEW.last_error_code='recovery_needed'; NEW.last_error_message='Recovery did not complete. The source is preserved.';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cloud_workspace_fence_quarantined_workspace() FROM PUBLIC;
CREATE TRIGGER cloud_workspace_quarantine_workspace BEFORE UPDATE ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION cloud_workspace_fence_quarantined_workspace();

-- An old binary continues issuing its generic rollback writes after this
-- update. Normalize the transition and queue safety work here, then the above
-- workspace/intent guards prevent its later writes from reviving the source.
CREATE FUNCTION cloud_workspace_reject_recovery_rollback() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE intent_operation text; intent_generation integer; intent_key text;
BEGIN
  IF NEW.operation='recover' AND NEW.state='rolling_back' THEN
    NEW.state='rollback_failed'; NEW.completed_at=now(); NEW.updated_at=now();
    UPDATE cloud_workspaces SET current_generation=NEW.source_generation,desired_state='stopped',status='failed',
      authority_epoch=authority_epoch+1,version=version+1,updated_at=now(),last_error_code='recovery_needed',
      last_error_message='Recovery did not complete. The source is preserved.'
      WHERE id=NEW.workspace_id AND org_id=NEW.org_id AND current_generation IN (NEW.source_generation,NEW.candidate_generation)
        AND desired_state IN ('running','stopped') AND deleted_at IS NULL;
    UPDATE cloud_workspace_restore_incidents SET state='recovery_needed',reason='recovery_candidate_rejected',updated_at=now()
      WHERE transition_id=NEW.id;
    UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=now(),updated_at=now()
      WHERE workspace_id=NEW.workspace_id AND generation IN (NEW.source_generation,NEW.candidate_generation)
        AND operation IN ('wake','create') AND state IN ('queued','observing');
    FOREACH intent_operation IN ARRAY ARRAY['stop','delete'] LOOP
      intent_generation=CASE WHEN intent_operation='stop' THEN NEW.source_generation ELSE NEW.candidate_generation END;
      intent_key='system:recovery-fence:'||NEW.id::text||':'||intent_operation;
      INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,affects_workspace,generation_transition_id)
        VALUES(gen_random_uuid(),NEW.workspace_id,intent_generation,NEW.org_id,intent_operation::cloud_workspace_operation,intent_key,
          digest(intent_key,'sha256'),false,NEW.id) ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cloud_workspace_reject_recovery_rollback() FROM PUBLIC;
CREATE TRIGGER cloud_workspace_reject_recovery_rollback BEFORE UPDATE OF state
  ON cloud_workspace_generation_transitions FOR EACH ROW EXECUTE FUNCTION cloud_workspace_reject_recovery_rollback();
-- Repair a recovery rollback already published by the previous backend.
UPDATE cloud_workspace_generation_transitions SET state=state WHERE operation='recover' AND state='rolling_back';

-- Quarantine also fences older setup workers and wake routes. A later healthy
-- generation has its own admission and is not affected by the source fence.
CREATE OR REPLACE FUNCTION cloud_workspace_runtime_authority_live(
  target_workspace_id uuid,target_generation integer,target_user_id uuid,require_workos boolean
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT cloud_workspace_paid_authority_live(target_workspace_id,target_user_id,require_workos)
    AND cloud_workspace_generation_provider_authority_live(target_workspace_id,target_generation,300)
    AND cloud_workspace_compute_authority_live(target_workspace_id,target_generation)
    AND NOT EXISTS(SELECT 1 FROM cloud_workspace_restore_incidents incident
      WHERE incident.workspace_id=target_workspace_id AND incident.source_generation=target_generation
        AND (incident.automatic_started_at IS NOT NULL OR incident.state='recovery_needed'))
    AND NOT EXISTS(SELECT 1 FROM cloud_workspace_generation_transitions transition
      WHERE transition.workspace_id=target_workspace_id AND transition.source_generation=target_generation
        AND transition.operation='recover')
$$;
