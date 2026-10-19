-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Rollout MUST drain old destructive dispatches before installing this gate.
-- A database trigger cannot revoke a provider call already admitted in memory.
-- Rollback retains this gate and the recovery records; no unsaved fallback.
ALTER TABLE cloud_workspace_engine_instances ADD COLUMN final_save_version smallint
  CHECK (final_save_version IS NULL OR final_save_version=1);
ALTER TABLE workspace_checkpoints ADD COLUMN final_save_body_sha256 bytea
  CHECK (final_save_body_sha256 IS NULL OR octet_length(final_save_body_sha256)=32);
ALTER TABLE cloud_workspace_lifecycle_intents ADD COLUMN restart_version smallint
  CHECK (restart_version IS NULL OR (restart_version=1 AND operation='wake' AND resume_after_intent_id IS NOT NULL));
ALTER TABLE cloud_workspaces ADD COLUMN accepted_lifecycle_intent_id uuid
  REFERENCES cloud_workspace_lifecycle_intents(id) ON DELETE SET NULL;

CREATE TABLE cloud_workspace_final_save_recoveries (
  lifecycle_intent_id uuid PRIMARY KEY REFERENCES cloud_workspace_lifecycle_intents(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation>0),
  operation text NOT NULL CHECK (operation IN ('stop','archive','delete')),
  original_request_id uuid,
  current_request_id uuid,
  attempt_ordinal integer NOT NULL DEFAULT 0 CHECK (attempt_ordinal>=0),
  state text NOT NULL DEFAULT 'capturing' CHECK (state IN ('capturing','retrying','reconciling','blocked','proven','resolved')),
  engine_instance_id uuid,
  registered_at timestamptz,
  registration_token_sha256 bytea CHECK (registration_token_sha256 IS NULL OR octet_length(registration_token_sha256)=32),
  runtime_id text,
  boot_id uuid,
  writer_epoch uuid,
  funding_owner_user_id uuid,
  funding_owner_epoch bigint CHECK (funding_owner_epoch>0),
  authority_epoch bigint NOT NULL CHECK (authority_epoch>0),
  allocation_lease_id uuid,
  provider_resource_id text,
  custody_id uuid,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count>=0),
  failure_started_at timestamptz,
  first_failure text,
  last_failure text,
  last_checked_at timestamptz,
  proven_request_id uuid,
  checkpoint_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lifecycle_intent_id,workspace_id,generation,org_id),
  FOREIGN KEY (workspace_id,generation,org_id)
    REFERENCES cloud_workspace_generations(workspace_id,generation,org_id) ON DELETE CASCADE,
  FOREIGN KEY (original_request_id,workspace_id,generation,org_id)
    REFERENCES workspace_checkpoint_requests(id,workspace_id,generation,org_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (current_request_id,workspace_id,generation,org_id)
    REFERENCES workspace_checkpoint_requests(id,workspace_id,generation,org_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (proven_request_id,workspace_id,generation,org_id)
    REFERENCES workspace_checkpoint_requests(id,workspace_id,generation,org_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (checkpoint_id,workspace_id,org_id)
    REFERENCES workspace_checkpoints(id,workspace_id,org_id) ON DELETE RESTRICT,
  CHECK ((state IN ('proven','resolved'))=(checkpoint_id IS NOT NULL AND proven_request_id IS NOT NULL)),
  CHECK (first_failure IS NULL OR first_failure IN ('capture_failed','commit_ambiguous','checkpoint_deadline_exceeded',
    'legacy_cancelled','authority','custody','journal','scope','source_unavailable')),
  CHECK (last_failure IS NULL OR last_failure IN ('capture_failed','commit_ambiguous','checkpoint_deadline_exceeded',
    'legacy_cancelled','authority','custody','journal','scope','source_unavailable'))
);
CREATE INDEX cloud_final_save_due ON cloud_workspace_final_save_recoveries(next_attempt_at,org_id,workspace_id)
  WHERE state NOT IN ('proven','resolved');
CREATE INDEX cloud_final_save_workspace ON cloud_workspace_final_save_recoveries(workspace_id,org_id,generation);
ALTER TABLE cloud_workspace_final_save_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_final_save_recoveries FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_workspace_final_save_recoveries USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_workspace_final_save_recoveries TO zeros_app;

ALTER TABLE workspace_checkpoint_requests ADD COLUMN final_save_recovery_id uuid;
ALTER TABLE workspace_checkpoint_requests ADD COLUMN final_save_attempt_ordinal integer;
ALTER TABLE workspace_checkpoint_requests ADD COLUMN final_save_retirement_id uuid;
ALTER TABLE workspace_checkpoint_requests ADD COLUMN final_save_capture_report jsonb;
ALTER TABLE workspace_checkpoint_requests ADD COLUMN final_save_commit_report jsonb;
ALTER TABLE workspace_checkpoint_requests ADD COLUMN final_save_reconcile_report jsonb;
ALTER TABLE workspace_checkpoint_requests ADD CONSTRAINT final_save_request_scope
  FOREIGN KEY (final_save_recovery_id,workspace_id,generation,org_id)
  REFERENCES cloud_workspace_final_save_recoveries(lifecycle_intent_id,workspace_id,generation,org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE workspace_checkpoint_requests ADD CONSTRAINT final_save_attempt_identity CHECK (
  (final_save_recovery_id IS NULL AND final_save_attempt_ordinal IS NULL) OR
  (final_save_recovery_id IS NOT NULL AND final_save_attempt_ordinal IS NOT NULL AND final_save_attempt_ordinal>=0 AND
    ((final_save_attempt_ordinal=0 AND lifecycle_intent_id IS NOT NULL AND lifecycle_intent_id=final_save_recovery_id) OR
     (final_save_attempt_ordinal>0 AND lifecycle_intent_id IS NULL)))
);
ALTER TABLE workspace_checkpoint_requests ADD CONSTRAINT final_save_report_bounds CHECK (
  (final_save_capture_report IS NULL OR (jsonb_typeof(final_save_capture_report)='object' AND pg_column_size(final_save_capture_report)<=8192)) AND
  (final_save_commit_report IS NULL OR (jsonb_typeof(final_save_commit_report)='object' AND pg_column_size(final_save_commit_report)<=8192)) AND
  (final_save_reconcile_report IS NULL OR (jsonb_typeof(final_save_reconcile_report)='object' AND pg_column_size(final_save_reconcile_report)<=8192))
);
CREATE UNIQUE INDEX cloud_final_save_attempt_ordinal ON workspace_checkpoint_requests(final_save_recovery_id,final_save_attempt_ordinal)
  WHERE final_save_recovery_id IS NOT NULL;
-- zeros-expand-exception: widen-check Adds successor states while retaining every legacy state
ALTER TABLE workspace_checkpoint_requests DROP CONSTRAINT workspace_checkpoint_requests_state_check;
ALTER TABLE workspace_checkpoint_requests ADD CONSTRAINT workspace_checkpoint_requests_state_check CHECK (
  state IN ('queued','delivered','recovery_queued','recovery_delivered','succeeded','failed','cancelled','expired'));
-- zeros-expand-exception: widen-check Successors retain the existing live versus terminal completion invariant
ALTER TABLE workspace_checkpoint_requests DROP CONSTRAINT workspace_checkpoint_requests_check1;
ALTER TABLE workspace_checkpoint_requests ADD CONSTRAINT workspace_checkpoint_requests_check1 CHECK (
  (state IN ('succeeded','failed','cancelled','expired') AND completed_at IS NOT NULL) OR
  (state IN ('queued','delivered','recovery_queued','recovery_delivered') AND completed_at IS NULL));
ALTER TABLE workspace_checkpoint_requests ADD CONSTRAINT final_save_successor_state CHECK (
  (state NOT IN ('recovery_queued','recovery_delivered') OR (final_save_attempt_ordinal IS NOT NULL AND final_save_attempt_ordinal>0)) AND
  (coalesce(final_save_attempt_ordinal,0)=0 OR state NOT IN ('queued','delivered')));
CREATE UNIQUE INDEX cloud_final_save_one_active_attempt ON workspace_checkpoint_requests(final_save_recovery_id)
  WHERE final_save_recovery_id IS NOT NULL AND state IN ('queued','delivered','recovery_queued','recovery_delivered');
CREATE INDEX cloud_final_save_successor_deadline ON workspace_checkpoint_requests(deadline_at,org_id,workspace_id)
  WHERE state IN ('recovery_queued','recovery_delivered');

-- Allocation ids are frozen evidence, not lease locks: workspace -> compute
-- lock order must not be reversed by an implicit lease foreign-key lock.
CREATE FUNCTION ensure_cloud_final_save_recovery(target_intent_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  INSERT INTO cloud_workspace_final_save_recoveries(lifecycle_intent_id,workspace_id,org_id,generation,operation,
    engine_instance_id,registered_at,registration_token_sha256,runtime_id,boot_id,writer_epoch,
    funding_owner_user_id,funding_owner_epoch,authority_epoch,allocation_lease_id,provider_resource_id,next_attempt_at,
    state,proven_request_id,checkpoint_id)
  SELECT intent.id,intent.workspace_id,intent.org_id,intent.generation,intent.operation::text,
    engine.id,engine.registered_at,engine.heartbeat_token_hash,engine.runtime_id,boot.boot_id,boot.writer_epoch,
    boot.funding_owner_user_id,boot.funding_owner_epoch,coalesce(saved.authority_epoch,historical.authority_epoch,workspace.authority_epoch),
    coalesce(owner.allocation_lease_id,lease.id),binding.provider_resource_id,clock_timestamp()+interval '5 minutes',
    CASE WHEN saved.checkpoint_id IS NULL THEN 'capturing' ELSE 'proven' END,saved.proven_request_id,saved.checkpoint_id
  FROM cloud_workspace_lifecycle_intents intent
  JOIN cloud_workspaces workspace ON workspace.id=intent.workspace_id AND workspace.org_id=intent.org_id
  LEFT JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=intent.workspace_id
    AND binding.org_id=intent.org_id AND binding.generation=intent.generation
  LEFT JOIN LATERAL (SELECT instance.* FROM cloud_workspace_engine_instances instance
    WHERE instance.workspace_id=intent.workspace_id AND instance.org_id=intent.org_id AND instance.generation=intent.generation
      AND instance.created_at<=intent.created_at
    ORDER BY instance.enrollment_order DESC LIMIT 1) engine ON true
  LEFT JOIN cloud_agent_boot_bindings boot ON boot.engine_instance_id=engine.id AND boot.workspace_id=intent.workspace_id
    AND boot.org_id=intent.org_id AND boot.generation=intent.generation
  LEFT JOIN cloud_workspace_allocation_owners owner ON owner.workspace_id=intent.workspace_id AND owner.org_id=intent.org_id
    AND owner.provider_resource_id=binding.provider_resource_id AND owner.current_generation=intent.generation
  LEFT JOIN LATERAL (SELECT candidate.id FROM managed_compute_allocation_leases candidate
    WHERE candidate.workspace_id=intent.workspace_id AND candidate.org_id=intent.org_id AND candidate.generation=intent.generation
      AND candidate.provider_resource_id=binding.provider_resource_id ORDER BY candidate.created_at DESC,candidate.id LIMIT 1) lease ON true
  -- An encountered N-1 final receipt precedes the lifecycle epoch advance.
  -- Keep that receipt's epoch; a newer registration cannot adopt its proof.
  LEFT JOIN LATERAL (SELECT checkpoint.authority_epoch FROM workspace_checkpoint_requests request
    JOIN workspace_checkpoints checkpoint ON checkpoint.id=request.checkpoint_id
      AND checkpoint.workspace_id=intent.workspace_id AND checkpoint.org_id=intent.org_id AND checkpoint.generation=intent.generation
    WHERE request.lifecycle_intent_id=intent.id AND request.state='succeeded'
      AND request.reason IN ('before_stop','before_archive','before_delete','before_rebuild')
      AND checkpoint.reason=request.reason AND checkpoint.state='durable' AND checkpoint.invalidated_at IS NULL
      AND checkpoint.durable_at IS NOT NULL AND engine.registered_at<=checkpoint.durable_at
      AND engine.final_checkpoint_at IS NOT NULL AND engine.registered_at<=engine.final_checkpoint_at
    LIMIT 1) historical ON true
  LEFT JOIN LATERAL (SELECT previous.authority_epoch,previous.proven_request_id,previous.checkpoint_id
    FROM cloud_workspace_final_save_recoveries previous
    WHERE previous.workspace_id=intent.workspace_id AND previous.org_id=intent.org_id AND previous.generation=intent.generation
      AND previous.engine_instance_id=engine.id AND previous.registered_at=engine.registered_at
      AND previous.registration_token_sha256=engine.heartbeat_token_hash
      AND previous.runtime_id IS NOT DISTINCT FROM engine.runtime_id AND previous.boot_id IS NOT DISTINCT FROM boot.boot_id
      AND previous.writer_epoch IS NOT DISTINCT FROM boot.writer_epoch
      AND previous.provider_resource_id=binding.provider_resource_id
      AND previous.allocation_lease_id IS NOT DISTINCT FROM coalesce(owner.allocation_lease_id,lease.id)
      AND previous.state IN ('proven','resolved') AND cloud_final_save_proven(previous.lifecycle_intent_id)
    ORDER BY previous.created_at DESC,previous.lifecycle_intent_id LIMIT 1) saved ON true
  WHERE intent.id=target_intent_id AND intent.operation IN ('stop','archive','delete')
    AND (intent.idempotency_key NOT LIKE 'system:idle:%' OR cloud_workspace_drain_is_mandatory(intent.id)
      OR EXISTS (SELECT 1 FROM workspace_checkpoint_requests request WHERE request.lifecycle_intent_id=intent.id AND request.state='succeeded'))
  ON CONFLICT (lifecycle_intent_id) DO NOTHING;
END $$;

CREATE FUNCTION cloud_final_save_admitted() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM ensure_cloud_final_save_recovery(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_final_save_admitted AFTER INSERT ON cloud_workspace_lifecycle_intents
  FOR EACH ROW WHEN (NEW.operation IN ('stop','archive','delete')) EXECUTE FUNCTION cloud_final_save_admitted();

CREATE FUNCTION cloud_final_save_request_link() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.lifecycle_intent_id IS NOT NULL AND NEW.reason IN ('before_stop','before_archive','before_delete','before_rebuild') THEN
    PERFORM ensure_cloud_final_save_recovery(NEW.lifecycle_intent_id);
    IF EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=NEW.lifecycle_intent_id) THEN
      NEW.final_save_recovery_id=NEW.lifecycle_intent_id;
      NEW.final_save_attempt_ordinal=0;
      UPDATE cloud_workspace_final_save_recoveries SET original_request_id=NEW.id,current_request_id=NEW.id,
        next_attempt_at=NEW.deadline_at WHERE lifecycle_intent_id=NEW.lifecycle_intent_id AND original_request_id IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_final_save_request_link BEFORE INSERT ON workspace_checkpoint_requests
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_request_link();

-- Upgrade an actually encountered legacy row, not a migration-time backfill.
-- This also covers an N-1 worker's first expiry/cancellation after deployment.
CREATE TRIGGER aa_cloud_final_save_legacy_link BEFORE UPDATE OF state ON workspace_checkpoint_requests
  FOR EACH ROW WHEN (OLD.final_save_recovery_id IS NULL AND OLD.lifecycle_intent_id IS NOT NULL)
  EXECUTE FUNCTION cloud_final_save_request_link();

CREATE FUNCTION cloud_final_save_attempt_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF OLD.final_save_recovery_id IS NOT NULL AND (
    ROW(NEW.lifecycle_intent_id,NEW.final_save_recovery_id,NEW.final_save_attempt_ordinal,NEW.idempotency_key)
      IS DISTINCT FROM ROW(OLD.lifecycle_intent_id,OLD.final_save_recovery_id,OLD.final_save_attempt_ordinal,OLD.idempotency_key)
    OR NEW.deadline_at>OLD.deadline_at
    OR (OLD.final_save_retirement_id IS NOT NULL AND (NEW.final_save_retirement_id IS DISTINCT FROM OLD.final_save_retirement_id
      OR NEW.state NOT IN ('cancelled','expired','failed')))
    OR (OLD.final_save_capture_report IS NOT NULL AND NEW.final_save_capture_report IS DISTINCT FROM OLD.final_save_capture_report)
    OR (OLD.final_save_commit_report IS NOT NULL AND NEW.final_save_commit_report IS DISTINCT FROM OLD.final_save_commit_report)
    OR (OLD.final_save_reconcile_report IS NOT NULL AND NEW.final_save_reconcile_report IS DISTINCT FROM OLD.final_save_reconcile_report)
  ) THEN RAISE EXCEPTION 'immutable final save attempt' USING ERRCODE='23514'; END IF;
  IF NEW.final_save_recovery_id IS NOT NULL AND NEW.state IN ('cancelled','expired','failed') THEN
    NEW.final_save_retirement_id=coalesce(NEW.final_save_retirement_id,gen_random_uuid());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_final_save_attempt_immutable BEFORE UPDATE ON workspace_checkpoint_requests
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_attempt_immutable();

-- A real committed final checkpoint, tied to the original source. A seal by
-- itself, absence, revocation, cancellation or stop_unsealed is never proof.
CREATE FUNCTION cloud_final_save_proven(target_intent_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM cloud_workspace_final_save_recoveries recovery
    JOIN workspace_checkpoint_requests request ON request.id=coalesce(recovery.proven_request_id,recovery.current_request_id)
      AND request.workspace_id=recovery.workspace_id AND request.org_id=recovery.org_id AND request.generation=recovery.generation
    JOIN workspace_checkpoints checkpoint ON checkpoint.id=request.checkpoint_id
      AND checkpoint.workspace_id=request.workspace_id AND checkpoint.org_id=request.org_id AND checkpoint.generation=request.generation
    JOIN cloud_workspace_engine_instances engine ON engine.id=recovery.engine_instance_id
      AND engine.workspace_id=recovery.workspace_id AND engine.org_id=recovery.org_id AND engine.generation=recovery.generation
    JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=recovery.workspace_id
      AND binding.org_id=recovery.org_id AND binding.generation=recovery.generation
    WHERE recovery.lifecycle_intent_id=target_intent_id AND request.state='succeeded'
      AND ((recovery.proven_request_id=request.id AND request.reason IN ('before_stop','before_archive','before_delete','before_rebuild'))
        OR request.reason='before_'||recovery.operation OR (recovery.operation='stop' AND request.reason='before_rebuild'
        AND EXISTS (SELECT 1 FROM cloud_workspace_generation_transitions transition WHERE transition.drain_intent_id=target_intent_id)))
      AND checkpoint.reason=request.reason
      AND checkpoint.state='durable' AND checkpoint.invalidated_at IS NULL AND checkpoint.durable_at IS NOT NULL
      AND checkpoint.authority_epoch=recovery.authority_epoch
      AND binding.provider_resource_id=recovery.provider_resource_id
      AND engine.registered_at=recovery.registered_at AND engine.heartbeat_token_hash=recovery.registration_token_sha256
      AND engine.registered_at<=checkpoint.durable_at AND engine.registered_at<=engine.final_checkpoint_at
      AND engine.runtime_id IS NOT DISTINCT FROM recovery.runtime_id
      AND (recovery.boot_id IS NULL OR engine.runtime_boot_id=recovery.boot_id)
      AND engine.final_checkpoint_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_engine_instances newer WHERE newer.workspace_id=recovery.workspace_id
        AND newer.org_id=recovery.org_id AND newer.generation=recovery.generation AND newer.enrollment_order>engine.enrollment_order)
      AND (recovery.allocation_lease_id IS NULL OR EXISTS (SELECT 1 FROM managed_compute_allocation_leases lease
        WHERE lease.id=recovery.allocation_lease_id AND lease.workspace_id=recovery.workspace_id AND lease.org_id=recovery.org_id
          AND lease.provider_resource_id=recovery.provider_resource_id))
      AND recovery.allocation_lease_id IS NOT DISTINCT FROM (SELECT latest.id FROM managed_compute_allocation_leases latest
        WHERE latest.workspace_id=recovery.workspace_id AND latest.org_id=recovery.org_id
          AND latest.provider_resource_id=recovery.provider_resource_id
        ORDER BY latest.created_at DESC,latest.id LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_allocation_owners owner WHERE owner.workspace_id=recovery.workspace_id
        AND owner.provider_resource_id=recovery.provider_resource_id AND
          (owner.current_generation<>recovery.generation OR owner.allocation_lease_id IS DISTINCT FROM recovery.allocation_lease_id))
      AND (coalesce(engine.cloud_local_commands_version,0)<>1 OR EXISTS (
        SELECT 1 FROM cloud_workspace_local_command_writers writer WHERE writer.workspace_id=recovery.workspace_id
          AND writer.org_id=recovery.org_id AND writer.generation=recovery.generation AND writer.engine_instance_id=engine.id
          AND writer.boot_id=recovery.boot_id AND writer.writer_epoch=recovery.writer_epoch
          AND writer.funding_owner_user_id=recovery.funding_owner_user_id AND writer.funding_owner_epoch=recovery.funding_owner_epoch
          AND writer.activated_at IS NOT NULL AND writer.sealed_sequence IS NOT NULL AND writer.seal_ack IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_local_command_writers writer
        JOIN cloud_workspace_engine_instances writer_engine ON writer_engine.id=writer.engine_instance_id
        WHERE writer.workspace_id=recovery.workspace_id
        AND writer.org_id=recovery.org_id AND writer.generation=recovery.generation AND writer.activated_at IS NOT NULL
        AND (writer.sealed_sequence IS NULL OR writer.seal_ack IS NULL OR
          (writer.writer_epoch IS DISTINCT FROM recovery.writer_epoch AND NOT
            (writer.state='retired' AND writer_engine.enrollment_order<engine.enrollment_order))))
  )
$$;

-- Runs after the existing engine final fence, in the very same commit. Worker
-- scheduling, a lost ACK, or later runtime retirement cannot lose this proof.
CREATE FUNCTION cloud_final_save_adopt_proof(target_intent_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  UPDATE cloud_workspace_final_save_recoveries target SET state='proven',proven_request_id=request.id,
    checkpoint_id=request.checkpoint_id,last_checked_at=clock_timestamp(),updated_at=clock_timestamp()
  FROM workspace_checkpoint_requests request
  WHERE target.lifecycle_intent_id=target_intent_id AND target.state NOT IN ('proven','resolved')
    AND request.id=target.current_request_id AND cloud_final_save_proven(target.lifecycle_intent_id);
  UPDATE cloud_workspace_final_save_recoveries target SET state='proven',proven_request_id=saved.proven_request_id,
    checkpoint_id=saved.checkpoint_id,last_checked_at=clock_timestamp(),updated_at=clock_timestamp()
  FROM cloud_workspace_final_save_recoveries saved
  WHERE target.lifecycle_intent_id=target_intent_id AND target.state NOT IN ('proven','resolved')
    AND saved.state IN ('proven','resolved') AND cloud_final_save_proven(saved.lifecycle_intent_id)
    AND ROW(target.workspace_id,target.org_id,target.generation,target.engine_instance_id,target.registered_at,
      target.registration_token_sha256,target.runtime_id,target.boot_id,target.writer_epoch,target.funding_owner_user_id,
      target.funding_owner_epoch,target.authority_epoch,target.allocation_lease_id,target.provider_resource_id)
      IS NOT DISTINCT FROM ROW(saved.workspace_id,saved.org_id,saved.generation,saved.engine_instance_id,saved.registered_at,
      saved.registration_token_sha256,saved.runtime_id,saved.boot_id,saved.writer_epoch,saved.funding_owner_user_id,
      saved.funding_owner_epoch,saved.authority_epoch,saved.allocation_lease_id,saved.provider_resource_id);
  -- A sibling request is really retired, not forged as a second successful
  -- capture. The logical action uses the exact already-committed source proof.
  UPDATE workspace_checkpoint_requests request SET state='cancelled',completed_at=clock_timestamp(),error_code='final_save_source_proven'
    FROM cloud_workspace_final_save_recoveries recovery WHERE recovery.lifecycle_intent_id=target_intent_id
      AND recovery.state='proven' AND request.id=recovery.current_request_id AND request.id<>recovery.proven_request_id
      AND request.state IN ('queued','delivered','recovery_queued','recovery_delivered');
END $$;

CREATE FUNCTION cloud_final_save_committed() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE sibling uuid;
BEGIN
  IF NEW.state<>'succeeded' OR NEW.reason NOT IN ('before_stop','before_archive','before_delete','before_rebuild') THEN RETURN NEW; END IF;
  IF NEW.lifecycle_intent_id IS NOT NULL THEN
    PERFORM ensure_cloud_final_save_recovery(NEW.lifecycle_intent_id);
    UPDATE cloud_workspace_final_save_recoveries SET original_request_id=NEW.id,current_request_id=NEW.id
      WHERE lifecycle_intent_id=NEW.lifecycle_intent_id AND original_request_id IS NULL AND state NOT IN ('proven','resolved');
    UPDATE workspace_checkpoint_requests SET final_save_recovery_id=NEW.lifecycle_intent_id,final_save_attempt_ordinal=0
      WHERE id=NEW.id AND final_save_recovery_id IS NULL
        AND EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=NEW.lifecycle_intent_id);
  END IF;
  UPDATE cloud_workspace_final_save_recoveries SET state='proven',proven_request_id=NEW.id,checkpoint_id=NEW.checkpoint_id,
    last_checked_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE current_request_id=NEW.id AND state NOT IN ('proven','resolved') AND cloud_final_save_proven(lifecycle_intent_id);
  FOR sibling IN SELECT lifecycle_intent_id FROM cloud_workspace_final_save_recoveries
    WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id AND generation=NEW.generation AND state NOT IN ('proven','resolved') LOOP
    PERFORM cloud_final_save_adopt_proof(sibling);
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_cloud_final_save_committed AFTER INSERT OR UPDATE OF state ON workspace_checkpoint_requests
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_committed();

CREATE FUNCTION cloud_final_save_require_dispatch() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.operation IN ('stop','archive','delete') AND NEW.state='dispatching' THEN
    PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE;
    IF NOT cloud_final_save_proven(NEW.id) THEN
      -- Old workers ignore RETURNING. Raising is required; rewriting state
      -- silently would leave their in-memory provider dispatch authorized.
      RAISE EXCEPTION 'final save proof is required before dispatch' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_final_save_require_dispatch BEFORE INSERT OR UPDATE OF state ON cloud_workspace_lifecycle_intents
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_require_dispatch();

CREATE FUNCTION cloud_final_save_preserve_lifecycle() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.state IN ('failed','superseded') AND OLD.operation IN ('stop','archive','delete') THEN
    PERFORM ensure_cloud_final_save_recovery(OLD.id);
  END IF;
  IF NEW.state IN ('failed','superseded') AND OLD.state IN ('queued','observing','dispatching')
    AND EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=OLD.id AND state<>'resolved')
    AND NOT cloud_final_save_proven(OLD.id) THEN
    NEW.state=CASE WHEN OLD.state='dispatching' THEN 'observing'::cloud_workspace_intent_state ELSE OLD.state END;
    NEW.completed_at=NULL; NEW.error_code=OLD.error_code; NEW.error_message=OLD.error_message;
    NEW.lease_owner=NULL; NEW.lease_expires_at=NULL;
  END IF;
  RETURN NEW;
END $$;
-- After the existing mandatory-drain guard; accepted explicit operations also
-- survive legacy failure writes, without pretending their request is live.
CREATE TRIGGER zz_cloud_final_save_preserve_lifecycle BEFORE UPDATE OF state ON cloud_workspace_lifecycle_intents
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_preserve_lifecycle();

CREATE FUNCTION cloud_final_save_preserve_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF OLD.state='draining' AND NEW.state='cancelled' THEN PERFORM ensure_cloud_final_save_recovery(OLD.drain_intent_id); END IF;
  -- A later explicit lifecycle action may cancel the replacement plan. Its
  -- unsaved drain remains protected independently by preserve_lifecycle.
  -- A capture failure/expiry cannot cancel that plan on the owner's behalf.
  IF OLD.state='draining' AND NEW.state='cancelled'
    AND NEW.error_code IS DISTINCT FROM 'generation_transition_cancelled' AND EXISTS (
    SELECT 1 FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=OLD.drain_intent_id AND state NOT IN ('proven','resolved')) THEN
    NEW.state=OLD.state; NEW.completed_at=OLD.completed_at; NEW.error_code=OLD.error_code; NEW.error_message=OLD.error_message;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_final_save_preserve_transition BEFORE UPDATE OF state ON cloud_workspace_generation_transitions
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_preserve_transition();

CREATE FUNCTION cloud_final_save_preserve_candidate() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE intent_id uuid;
BEGIN
  IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL THEN
    FOR intent_id IN SELECT drain_intent_id FROM cloud_workspace_generation_transitions
      WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id AND candidate_generation=NEW.generation AND state='draining' LOOP
      PERFORM ensure_cloud_final_save_recovery(intent_id);
    END LOOP;
  END IF;
  IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM cloud_workspace_generation_transitions transition
    JOIN cloud_workspace_final_save_recoveries recovery ON recovery.lifecycle_intent_id=transition.drain_intent_id
    WHERE transition.workspace_id=NEW.workspace_id AND transition.org_id=NEW.org_id
      AND transition.candidate_generation=NEW.generation AND transition.state='draining'
      AND recovery.state NOT IN ('proven','resolved')) THEN NEW.retired_at=NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_final_save_preserve_candidate BEFORE UPDATE OF retired_at ON cloud_workspace_generations
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_preserve_candidate();

ALTER TABLE workspace_checkpoint_requests ADD CONSTRAINT final_save_attempt_current_identity
  UNIQUE (id,final_save_recovery_id,final_save_attempt_ordinal);
ALTER TABLE cloud_workspace_final_save_recoveries ADD CONSTRAINT final_save_current_attempt
  FOREIGN KEY (current_request_id,lifecycle_intent_id,attempt_ordinal)
  REFERENCES workspace_checkpoint_requests(id,final_save_recovery_id,final_save_attempt_ordinal)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION cloud_final_save_source_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF ROW(NEW.lifecycle_intent_id,NEW.workspace_id,NEW.org_id,NEW.generation,NEW.operation,NEW.engine_instance_id,
    NEW.registered_at,NEW.registration_token_sha256,NEW.runtime_id,NEW.boot_id,NEW.writer_epoch,NEW.funding_owner_user_id,
    NEW.funding_owner_epoch,NEW.authority_epoch,NEW.allocation_lease_id,NEW.provider_resource_id)
    IS DISTINCT FROM ROW(OLD.lifecycle_intent_id,OLD.workspace_id,OLD.org_id,OLD.generation,OLD.operation,OLD.engine_instance_id,
    OLD.registered_at,OLD.registration_token_sha256,OLD.runtime_id,OLD.boot_id,OLD.writer_epoch,OLD.funding_owner_user_id,
    OLD.funding_owner_epoch,OLD.authority_epoch,OLD.allocation_lease_id,OLD.provider_resource_id)
    OR (OLD.original_request_id IS NOT NULL AND NEW.original_request_id IS DISTINCT FROM OLD.original_request_id)
    OR (OLD.custody_id IS NOT NULL AND NEW.custody_id IS DISTINCT FROM OLD.custody_id)
    OR (OLD.failure_started_at IS NOT NULL AND ROW(NEW.failure_started_at,NEW.first_failure) IS DISTINCT FROM ROW(OLD.failure_started_at,OLD.first_failure))
    OR (OLD.checkpoint_id IS NOT NULL AND ROW(NEW.checkpoint_id,NEW.proven_request_id) IS DISTINCT FROM ROW(OLD.checkpoint_id,OLD.proven_request_id)) THEN
    RAISE EXCEPTION 'immutable final save source' USING ERRCODE='23514';
  END IF;
  IF OLD.current_request_id IS NOT NULL AND NEW.current_request_id IS DISTINCT FROM OLD.current_request_id AND (
    NEW.attempt_ordinal<>OLD.attempt_ordinal+1 OR NOT EXISTS (
      SELECT 1 FROM workspace_checkpoint_requests request WHERE request.id=OLD.current_request_id
        AND request.state IN ('cancelled','expired','failed') AND request.final_save_retirement_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'final save predecessor retirement required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_final_save_source_immutable BEFORE UPDATE ON cloud_workspace_final_save_recoveries
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_source_immutable();

CREATE FUNCTION cloud_final_save_attempt_settled() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE failure text;
BEGIN
  IF NEW.final_save_recovery_id IS NULL OR NEW.state NOT IN ('cancelled','expired','failed') OR NEW.state=OLD.state THEN RETURN NEW; END IF;
  failure=CASE WHEN NEW.state='expired' THEN 'checkpoint_deadline_exceeded' ELSE 'legacy_cancelled' END;
  UPDATE cloud_workspace_final_save_recoveries SET state='blocked',
    failure_started_at=coalesce(failure_started_at,clock_timestamp()),first_failure=coalesce(first_failure,failure),last_failure=failure,
    next_attempt_at=clock_timestamp()+(ARRAY[5,15,30,60,120,300])[least(retry_count,5)+1]*interval '1 second',
    retry_count=least(retry_count+1,1000000),updated_at=clock_timestamp()
    WHERE lifecycle_intent_id=NEW.final_save_recovery_id AND current_request_id=NEW.id AND state NOT IN ('proven','resolved');
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_final_save_attempt_settled AFTER UPDATE OF state ON workspace_checkpoint_requests
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_attempt_settled();

CREATE FUNCTION cloud_final_save_jobs() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.state NOT IN ('proven','resolved') THEN
    INSERT INTO control_plane_jobs AS job(kind,dedupe_key,org_id,workspace_id,run_at)
      VALUES('cloud_final_save_recovery','workspace:'||NEW.workspace_id::text,NEW.org_id,NEW.workspace_id,NEW.next_attempt_at)
    ON CONFLICT (kind,dedupe_key) WHERE state IN ('queued','running') DO UPDATE SET
      payload='{}'::jsonb,
      run_at=CASE WHEN job.state='queued' THEN least(job.run_at,EXCLUDED.run_at) ELSE job.run_at END,
      rerun_at=CASE WHEN job.state='running' THEN least(job.rerun_at,EXCLUDED.run_at) END,updated_at=clock_timestamp()
    WHERE job.payload<>'{}'::jsonb OR (job.state='queued' AND EXCLUDED.run_at<job.run_at)
      OR (job.state='running' AND (job.rerun_at IS NULL OR EXCLUDED.run_at<job.rerun_at));
  ELSIF NEW.state='proven' THEN
    PERFORM enqueue_cloud_lifecycle_job('cloud_lifecycle_intent',NEW.workspace_id,NEW.org_id,clock_timestamp());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_final_save_jobs AFTER INSERT OR UPDATE OF next_attempt_at,state ON cloud_workspace_final_save_recoveries
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_jobs();

-- A dispatch may have reached the provider even if its response was lost.
-- Keep the exact source/allocation unavailable for warm reuse or replacement
-- until a positive result is recorded, independently of worker lease expiry.
CREATE TABLE cloud_workspace_final_save_dispatches (
  lifecycle_intent_id uuid PRIMARY KEY REFERENCES cloud_workspace_final_save_recoveries(lifecycle_intent_id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL,
  provider_resource_id text NOT NULL,
  allocation_lease_id uuid,
  engine_instance_id uuid NOT NULL,
  boot_id uuid,
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  FOREIGN KEY (workspace_id,generation,org_id)
    REFERENCES cloud_workspace_generations(workspace_id,generation,org_id) ON DELETE CASCADE
);
CREATE INDEX cloud_final_save_dispatch_pending ON cloud_workspace_final_save_dispatches(workspace_id,org_id,generation)
  WHERE settled_at IS NULL;
ALTER TABLE cloud_workspace_final_save_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_final_save_dispatches FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_workspace_final_save_dispatches USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_workspace_final_save_dispatches TO zeros_app;

CREATE FUNCTION cloud_final_save_dispatch_claimed() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.operation IN ('stop','archive','delete') AND NEW.state='dispatching' THEN
    INSERT INTO cloud_workspace_final_save_dispatches(lifecycle_intent_id,workspace_id,org_id,generation,
      provider_resource_id,allocation_lease_id,engine_instance_id,boot_id)
    SELECT lifecycle_intent_id,workspace_id,org_id,generation,provider_resource_id,allocation_lease_id,engine_instance_id,boot_id
      FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=NEW.id
    ON CONFLICT (lifecycle_intent_id) DO NOTHING;
  ELSIF NEW.operation IN ('stop','archive','delete') AND NEW.state='succeeded' THEN
    UPDATE cloud_workspace_final_save_dispatches dispatch SET settled_at=clock_timestamp()
      FROM cloud_workspace_provider_bindings binding WHERE dispatch.lifecycle_intent_id=NEW.id AND dispatch.settled_at IS NULL
        AND binding.workspace_id=dispatch.workspace_id AND binding.org_id=dispatch.org_id AND binding.generation=dispatch.generation
        AND binding.provider_resource_id=dispatch.provider_resource_id AND binding.last_observed_at>=dispatch.admitted_at
        AND ((NEW.operation='stop' AND binding.observed_state IN ('stopped','archived','deleted'))
          OR (NEW.operation='archive' AND binding.observed_state IN ('archived','deleted'))
          OR (NEW.operation='delete' AND binding.deletion_verified_at>=dispatch.admitted_at));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_final_save_dispatch_claimed AFTER UPDATE OF state ON cloud_workspace_lifecycle_intents
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_dispatch_claimed();

CREATE FUNCTION cloud_final_save_hold_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scope_id uuid; changed boolean;
BEGIN
  IF TG_TABLE_NAME='cloud_workspaces' THEN
    scope_id=NEW.id;
    changed=NEW.current_generation<>OLD.current_generation OR
      (NEW.agent_boot_id IS NOT NULL AND NEW.agent_boot_id IS DISTINCT FROM OLD.agent_boot_id);
  ELSIF TG_TABLE_NAME='cloud_workspace_provider_bindings' THEN
    scope_id=NEW.workspace_id;
    changed=NEW.provider_resource_id IS DISTINCT FROM OLD.provider_resource_id;
  ELSIF TG_TABLE_NAME='cloud_workspace_allocation_owners' THEN
    scope_id=NEW.workspace_id;
    changed=TG_OP='INSERT' OR ROW(NEW.current_generation,NEW.allocation_lease_id) IS DISTINCT FROM ROW(OLD.current_generation,OLD.allocation_lease_id);
  ELSIF TG_TABLE_NAME='managed_compute_allocation_leases' THEN
    scope_id=NEW.workspace_id;
    changed=TG_OP='INSERT' OR ROW(NEW.generation,NEW.provider_resource_id) IS DISTINCT FROM ROW(OLD.generation,OLD.provider_resource_id);
  ELSE
    scope_id=NEW.workspace_id;
    IF TG_OP='INSERT' THEN changed=true;
    ELSE changed=ROW(NEW.registered_at,NEW.heartbeat_token_hash,NEW.runtime_id,NEW.runtime_boot_id)
      IS DISTINCT FROM ROW(OLD.registered_at,OLD.heartbeat_token_hash,OLD.runtime_id,OLD.runtime_boot_id); END IF;
  END IF;
  IF changed THEN
    -- A lease worker may already own its lease. Never wait on the workspace
    -- in that order; a contested transition retries after releasing custody.
    PERFORM id FROM cloud_workspaces WHERE id=scope_id FOR UPDATE NOWAIT;
    IF EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches WHERE workspace_id=scope_id AND settled_at IS NULL) THEN
      RAISE EXCEPTION 'final save dispatch source is still held' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_final_save_hold_workspace BEFORE UPDATE OF current_generation,agent_boot_id ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_hold_source();
CREATE TRIGGER cloud_final_save_hold_binding BEFORE UPDATE OF provider_resource_id ON cloud_workspace_provider_bindings
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_hold_source();
CREATE TRIGGER cloud_final_save_hold_allocation BEFORE INSERT OR UPDATE OF current_generation,allocation_lease_id ON cloud_workspace_allocation_owners
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_hold_source();
CREATE TRIGGER cloud_final_save_hold_engine BEFORE INSERT OR UPDATE OF registered_at,heartbeat_token_hash,runtime_id,runtime_boot_id
  ON cloud_workspace_engine_instances FOR EACH ROW EXECUTE FUNCTION cloud_final_save_hold_source();
CREATE TRIGGER cloud_final_save_hold_lease BEFORE INSERT OR UPDATE OF generation,provider_resource_id ON managed_compute_allocation_leases
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_hold_source();

CREATE FUNCTION cloud_final_save_failure_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  INSERT INTO audit_log(org_id,actor_id,action,subject) VALUES(NEW.org_id,NULL,'cloud_workspace.final_save_recovery',
    jsonb_build_object('workspaceId',NEW.workspace_id,'generation',NEW.generation,'intentId',NEW.lifecycle_intent_id,
      'requestId',NEW.current_request_id,'reason',NEW.first_failure));
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_final_save_failure_audit AFTER UPDATE OF first_failure ON cloud_workspace_final_save_recoveries
  FOR EACH ROW WHEN (OLD.first_failure IS NULL AND NEW.first_failure IS NOT NULL) EXECUTE FUNCTION cloud_final_save_failure_audit();

-- Erasure is downstream of saved provider retirement, including N-1 jobs.
-- A missing resource is an observation, never a final-save proof.
CREATE FUNCTION cloud_final_save_deletion_claimable(target_workspace_id uuid,target_org_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries
      WHERE workspace_id=target_workspace_id AND org_id=target_org_id AND state NOT IN ('proven','resolved'))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches
      WHERE workspace_id=target_workspace_id AND org_id=target_org_id AND settled_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents intent
      WHERE intent.workspace_id=target_workspace_id AND intent.org_id=target_org_id AND intent.operation IN ('stop','archive','delete')
        AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=intent.id)
        -- Admission deliberately leaves a reversible idle attempt without
        -- recovery. Only its exact, retired, never-dispatched request can be
        -- omitted from history coverage; status or a missing row is not proof.
        AND NOT (intent.operation='stop' AND intent.requested_by IS NULL
          AND intent.state IN ('failed','superseded') AND intent.attempt_count=0 AND intent.dispatched_at IS NULL
          AND intent.generation_transition_id IS NULL AND NOT cloud_workspace_drain_is_mandatory(intent.id)
          AND NOT EXISTS (SELECT 1 FROM cloud_workspace_generation_transitions transition
            WHERE transition.workspace_id=intent.workspace_id AND transition.org_id=intent.org_id
              AND transition.drain_intent_id=intent.id)
          AND EXISTS (SELECT 1 FROM workspace_checkpoint_requests request
            WHERE request.lifecycle_intent_id=intent.id AND request.workspace_id=intent.workspace_id
              AND request.org_id=intent.org_id AND request.generation=intent.generation
              AND request.reason='before_stop' AND request.idle_engine_instance_id IS NOT NULL
              AND intent.idempotency_key LIKE 'system:idle:'||request.idle_engine_instance_id::text||':%'
              AND request.state IN ('failed','cancelled','expired') AND request.completed_at IS NOT NULL
              AND request.checkpoint_id IS NULL)))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspaces workspace
      JOIN cloud_workspace_engine_instances engine ON engine.workspace_id=workspace.id AND engine.org_id=workspace.org_id
        AND engine.generation=workspace.current_generation
      WHERE workspace.id=target_workspace_id AND workspace.org_id=target_org_id
        AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries recovery
          WHERE recovery.workspace_id=workspace.id AND recovery.org_id=workspace.org_id
            AND recovery.generation=workspace.current_generation AND recovery.state IN ('proven','resolved')))
$$;

CREATE FUNCTION cloud_final_save_protect_erasure() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE intent_id uuid;
BEGIN
  IF (NEW.lease_owner IS NOT NULL AND (TG_OP='INSERT' OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
    OR NEW.lease_expires_at>OLD.lease_expires_at)) OR (TG_OP='UPDATE' AND NEW.state IS DISTINCT FROM OLD.state
    AND NEW.state IN ('deleting_objects','deleting_records')) THEN
    -- Old claim SQL locks the job first: fail/retry instead of waiting in the
    -- opposite order to the parent-first purge/admission transactions.
    PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE NOWAIT;
    FOR intent_id IN SELECT id FROM cloud_workspace_lifecycle_intents
      WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id AND operation IN ('stop','archive','delete') LOOP
      PERFORM ensure_cloud_final_save_recovery(intent_id);
    END LOOP;
    IF NOT cloud_final_save_deletion_claimable(NEW.workspace_id,NEW.org_id) THEN
      RAISE EXCEPTION 'final save proof is required before erasure' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_final_save_protect_erasure BEFORE INSERT OR UPDATE OF state,lease_owner,lease_expires_at
  ON workspace_deletion_jobs FOR EACH ROW EXECUTE FUNCTION cloud_final_save_protect_erasure();

-- The old erasure worker deletes requests before checkpoints. Release the
-- new reciprocal FKs only at that same authorized boundary. Ordinary existing
-- retention may collect a terminal recovery only when it already selected its
-- old successful request; current head/export/generation protection is unchanged.
CREATE FUNCTION cloud_final_save_request_erasure() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target uuid;
BEGIN
  IF cloud_workspace_data_purge_authorized(OLD.workspace_id,OLD.org_id) THEN
    RETURN OLD;
  END IF;
  FOR target IN SELECT recovery.lifecycle_intent_id FROM cloud_workspace_final_save_recoveries recovery
    WHERE OLD.id IN (recovery.original_request_id,recovery.current_request_id,recovery.proven_request_id) LOOP
    IF EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries recovery
      JOIN cloud_workspace_lifecycle_intents intent ON intent.id=recovery.lifecycle_intent_id
      WHERE recovery.lifecycle_intent_id=target AND recovery.state IN ('proven','resolved')
        AND intent.state IN ('succeeded','failed','superseded')
        AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches dispatch WHERE dispatch.lifecycle_intent_id=target AND settled_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM workspace_content_heads head WHERE head.current_checkpoint_id=recovery.checkpoint_id)
        AND NOT EXISTS (SELECT 1 FROM cloud_workspace_generations generation WHERE generation.recovery_checkpoint_id=recovery.checkpoint_id)
        AND NOT EXISTS (SELECT 1 FROM workspace_exports export WHERE export.checkpoint_id=recovery.checkpoint_id)) THEN
      CONTINUE;
    ELSE RETURN NULL;
    END IF;
  END LOOP;
  RETURN OLD;
END $$;
CREATE TRIGGER cloud_final_save_request_erasure BEFORE DELETE ON workspace_checkpoint_requests
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_request_erasure();

-- AFTER events run when the outer request scan has finished. Removing the new
-- reciprocal owner from a BEFORE row trigger cascaded into that same scan and
-- made populated N-1 purges fail with a triggered tuple modification error.
-- zeros-expand-exception: final-save-purge Deletes only new terminal recovery metadata after an existing authorized request erasure
CREATE FUNCTION cloud_final_save_request_erased() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF cloud_workspace_data_purge_authorized(OLD.workspace_id,OLD.org_id) THEN
    DELETE FROM cloud_workspace_final_save_recoveries WHERE workspace_id=OLD.workspace_id AND org_id=OLD.org_id;
  ELSE
    DELETE FROM cloud_workspace_final_save_recoveries recovery USING cloud_workspace_lifecycle_intents intent
      WHERE OLD.id IN (recovery.original_request_id,recovery.current_request_id,recovery.proven_request_id)
        AND recovery.lifecycle_intent_id=intent.id AND recovery.workspace_id=OLD.workspace_id AND recovery.org_id=OLD.org_id
        AND recovery.state IN ('proven','resolved') AND intent.state IN ('succeeded','failed','superseded')
        AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches dispatch WHERE dispatch.lifecycle_intent_id=intent.id AND settled_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM workspace_content_heads head WHERE head.current_checkpoint_id=recovery.checkpoint_id)
        AND NOT EXISTS (SELECT 1 FROM cloud_workspace_generations generation WHERE generation.recovery_checkpoint_id=recovery.checkpoint_id)
        AND NOT EXISTS (SELECT 1 FROM workspace_exports export WHERE export.checkpoint_id=recovery.checkpoint_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER cloud_final_save_request_erased AFTER DELETE ON workspace_checkpoint_requests
  FOR EACH ROW EXECUTE FUNCTION cloud_final_save_request_erased();

-- One explicit app operation points to a durable intent. Internal replacement
-- work cannot overwrite it; ordinary subsequent user admission can. The
-- original generation is retained through a qualified automatic wake upgrade.
CREATE FUNCTION cloud_accepted_lifecycle_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.accepted_lifecycle_intent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cloud_workspace_lifecycle_intents intent WHERE intent.id=NEW.accepted_lifecycle_intent_id
      AND intent.workspace_id=NEW.id AND intent.org_id=NEW.org_id AND intent.generation<=NEW.current_generation
  ) THEN RAISE EXCEPTION 'accepted lifecycle scope mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_accepted_lifecycle_scope BEFORE INSERT OR UPDATE OF accepted_lifecycle_intent_id ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION cloud_accepted_lifecycle_scope();

CREATE FUNCTION cloud_restart_prerequisite_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.restart_version IS NOT NULL AND
    ROW(NEW.restart_version,NEW.resume_after_intent_id,NEW.workspace_id,NEW.org_id,NEW.generation)
      IS DISTINCT FROM ROW(OLD.restart_version,OLD.resume_after_intent_id,OLD.workspace_id,OLD.org_id,OLD.generation) THEN
    RAISE EXCEPTION 'immutable restart prerequisite' USING ERRCODE='23514';
  END IF;
  IF NEW.restart_version IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cloud_workspace_lifecycle_intents stop WHERE stop.id=NEW.resume_after_intent_id AND stop.operation='stop'
      AND stop.workspace_id=NEW.workspace_id AND stop.org_id=NEW.org_id AND stop.generation=NEW.generation
  ) THEN RAISE EXCEPTION 'restart prerequisite scope mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.restart_version IS NOT NULL AND NEW.state='dispatching' AND NOT EXISTS (
    SELECT 1 FROM cloud_workspace_lifecycle_intents stop
    JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=stop.workspace_id
      AND binding.org_id=stop.org_id AND binding.generation=stop.generation
    WHERE stop.id=NEW.resume_after_intent_id AND stop.state='succeeded' AND cloud_final_save_proven(stop.id)
      AND binding.observed_state IN ('stopped','archived')
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches held
        WHERE held.workspace_id=NEW.workspace_id AND held.org_id=NEW.org_id AND held.settled_at IS NULL)
  ) THEN RAISE EXCEPTION 'restart requires saved retirement' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_restart_prerequisite_scope BEFORE INSERT OR UPDATE ON cloud_workspace_lifecycle_intents
  FOR EACH ROW EXECUTE FUNCTION cloud_restart_prerequisite_scope();

-- The old source may publish ready late. Completion needs a new enrollment
-- after saved provider retirement, in the current generation of this Restart.
-- The caller below additionally proves the exact replacement/rollback lineage.
CREATE FUNCTION cloud_restart_ready(target_intent_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM cloud_workspace_lifecycle_intents intent
    JOIN cloud_workspaces workspace ON workspace.id=intent.workspace_id AND workspace.org_id=intent.org_id
    JOIN cloud_workspace_lifecycle_intents stop ON stop.id=intent.resume_after_intent_id
      AND stop.workspace_id=intent.workspace_id AND stop.org_id=intent.org_id AND stop.generation=intent.generation
    JOIN cloud_workspace_final_save_recoveries recovery ON recovery.lifecycle_intent_id=stop.id
    JOIN LATERAL (SELECT current.* FROM cloud_workspace_engine_instances current
      WHERE current.workspace_id=workspace.id AND current.org_id=workspace.org_id AND current.generation=workspace.current_generation
      ORDER BY current.enrollment_order DESC LIMIT 1) engine ON true
    WHERE intent.id=target_intent_id AND intent.restart_version=1 AND intent.state='succeeded'
      AND stop.state='succeeded' AND recovery.state IN ('proven','resolved')
      AND workspace.desired_state='running' AND workspace.status IN ('ready','busy')
      AND engine.id<>recovery.engine_instance_id AND engine.registered_at>=stop.completed_at
      AND engine.state='ready' AND engine.revoked_at IS NULL AND engine.final_checkpoint_at IS NULL
      AND engine.lease_expires_at>clock_timestamp() AND cloud_workspace_engine_interactive_live(engine)
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches held
        WHERE held.lifecycle_intent_id=stop.id AND held.settled_at IS NULL)
  )
$$;

CREATE FUNCTION cloud_workspace_accepted_lifecycle(target_workspace_id uuid,target_org_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT jsonb_build_object('version',1,'id',intent.id,
    'kind',CASE WHEN intent.restart_version=1 THEN 'restart' ELSE intent.operation::text END,
    'sourceGeneration',intent.generation,'phase',
      CASE WHEN intent.state='succeeded' AND recovery.state IN ('proven','resolved')
        AND (intent.restart_version IS NULL OR cloud_restart_ready(intent.id)) THEN 'completed'
        WHEN recovery.state NOT IN ('proven','resolved') THEN 'saving'
        WHEN intent.restart_version=1 AND predecessor.state='succeeded' THEN 'starting'
        WHEN intent.operation='archive' THEN 'archiving' WHEN intent.operation='delete' THEN 'deleting' ELSE 'stopping' END,
    'state',CASE WHEN intent.state='succeeded' AND recovery.state IN ('proven','resolved')
      AND (intent.restart_version IS NULL OR cloud_restart_ready(intent.id)) THEN 'completed' ELSE 'pending' END)
  FROM cloud_workspaces workspace JOIN cloud_workspace_lifecycle_intents intent ON intent.id=workspace.accepted_lifecycle_intent_id
    AND intent.workspace_id=workspace.id AND intent.org_id=workspace.org_id
  LEFT JOIN cloud_workspace_lifecycle_intents predecessor ON predecessor.id=intent.resume_after_intent_id
  LEFT JOIN cloud_workspace_final_save_recoveries recovery ON recovery.lifecycle_intent_id=
    CASE WHEN intent.restart_version=1 THEN intent.resume_after_intent_id ELSE intent.id END
  WHERE workspace.id=target_workspace_id AND workspace.org_id=target_org_id AND intent.state<>'superseded'
    AND (intent.restart_version=1 OR recovery.lifecycle_intent_id IS NOT NULL)
    AND (intent.generation=workspace.current_generation OR (intent.restart_version=1 AND EXISTS (
      SELECT 1 FROM cloud_workspace_generation_transitions transition JOIN cloud_workspace_lifecycle_intents drain ON drain.id=transition.drain_intent_id
      WHERE transition.workspace_id=workspace.id AND transition.org_id=workspace.org_id
        AND transition.source_generation=intent.generation AND transition.candidate_generation=workspace.current_generation
        AND drain.idempotency_key='runtime-upgrade:automatic-wake:'||intent.id::text)))
$$;

CREATE FUNCTION cloud_accepted_lifecycle_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME='cloud_workspace_final_save_recoveries' THEN target=NEW.lifecycle_intent_id;
  ELSE target=NEW.id; END IF;
  IF EXISTS (SELECT 1 FROM cloud_workspaces workspace LEFT JOIN cloud_workspace_lifecycle_intents accepted
      ON accepted.id=workspace.accepted_lifecycle_intent_id
    WHERE workspace.id=NEW.workspace_id AND workspace.org_id=NEW.org_id
      AND (accepted.id=target OR accepted.resume_after_intent_id=target)) THEN
    PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE NOWAIT;
    UPDATE cloud_workspaces SET version=version+1,updated_at=clock_timestamp() WHERE id=NEW.workspace_id AND org_id=NEW.org_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_accepted_intent_changed AFTER UPDATE OF state ON cloud_workspace_lifecycle_intents
  -- Claim/release/retry churn leaves the accepted projection unchanged. Only
  -- completion or retirement changes that projection (including Restart's
  -- predecessor), so passive exact-version reads survive ordinary polling.
  FOR EACH ROW WHEN (NEW.state IS DISTINCT FROM OLD.state AND
    (NEW.state IN ('succeeded','superseded') OR OLD.state IN ('succeeded','superseded')))
  EXECUTE FUNCTION cloud_accepted_lifecycle_changed();
CREATE TRIGGER cloud_accepted_save_changed AFTER UPDATE OF state ON cloud_workspace_final_save_recoveries
  FOR EACH ROW WHEN ((NEW.state IN ('proven','resolved')) IS DISTINCT FROM (OLD.state IN ('proven','resolved')))
  EXECUTE FUNCTION cloud_accepted_lifecycle_changed();

-- zeros-expand-exception: final-save-purge-authority Retains every scoped erasure fence and refuses unresolved final saves or provider dispatch custody
CREATE OR REPLACE FUNCTION cloud_workspace_data_purge_authorized(target_workspace_id uuid, target_org_id uuid)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT app_is_system() AND EXISTS (
    SELECT 1 FROM workspace_deletion_jobs job
    JOIN cloud_workspaces workspace ON workspace.id=job.workspace_id AND workspace.org_id=job.org_id
    WHERE job.workspace_id=target_workspace_id AND job.org_id=target_org_id
      AND job.id::text=nullif(current_setting('app.workspace_deletion_job_id',true),'')
      AND job.lease_owner=nullif(current_setting('app.workspace_deletion_lease_owner',true),'')
      AND job.state='deleting_records' AND job.lease_expires_at>clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries recovery
        WHERE recovery.workspace_id=target_workspace_id AND recovery.org_id=target_org_id AND recovery.state NOT IN ('proven','resolved'))
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches dispatch
        WHERE dispatch.workspace_id=target_workspace_id AND dispatch.org_id=target_org_id AND dispatch.settled_at IS NULL)
      AND workspace.status='deleted' AND workspace.desired_state='deleted' AND workspace.data_deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM workspace_deletion_blob_targets target
        JOIN workspace_blobs blob ON blob.id=target.blob_id AND blob.org_id=target.org_id
        WHERE target.job_id=job.id AND target.org_id=job.org_id AND (target.completed_at IS NULL OR blob.legal_hold))
      AND NOT EXISTS (SELECT 1 FROM workspace_blob_references reference
        WHERE reference.workspace_id=job.workspace_id AND reference.org_id=job.org_id)
      AND NOT EXISTS (SELECT 1 FROM workspace_retention_policies policy
        WHERE policy.workspace_id=job.workspace_id AND policy.org_id=job.org_id AND policy.legal_hold)
      AND NOT EXISTS (SELECT 1 FROM workspace_checkpoints checkpoint
        WHERE checkpoint.workspace_id=job.workspace_id AND checkpoint.org_id=job.org_id AND checkpoint.legal_hold)
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_generations generation
        LEFT JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=generation.workspace_id
          AND binding.generation=generation.generation AND binding.org_id=generation.org_id
        WHERE generation.workspace_id=job.workspace_id AND generation.org_id=job.org_id
          AND binding.deletion_verified_at IS NULL)
  )
$$;

-- Functions remain invoker-owned; the new relations enforce system-only RLS.
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION ensure_cloud_final_save_recovery(uuid) FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_admitted() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_request_link() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_attempt_immutable() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_proven(uuid) FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_adopt_proof(uuid) FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_committed() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_require_dispatch() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_preserve_lifecycle() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_preserve_transition() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_preserve_candidate() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_source_immutable() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_attempt_settled() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_jobs() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_dispatch_claimed() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_hold_source() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_failure_audit() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_deletion_claimable(uuid,uuid) FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_protect_erasure() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_request_erasure() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_final_save_request_erased() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_accepted_lifecycle_scope() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_restart_prerequisite_scope() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_restart_ready(uuid) FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_workspace_accepted_lifecycle(uuid,uuid) FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes default PUBLIC execute from a function introduced by this expansion
REVOKE ALL ON FUNCTION cloud_accepted_lifecycle_changed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_cloud_final_save_recovery(uuid) TO zeros_app;
GRANT EXECUTE ON FUNCTION cloud_final_save_proven(uuid) TO zeros_app;
GRANT EXECUTE ON FUNCTION cloud_final_save_adopt_proof(uuid) TO zeros_app;
GRANT EXECUTE ON FUNCTION cloud_final_save_deletion_claimable(uuid,uuid) TO zeros_app;
GRANT EXECUTE ON FUNCTION cloud_restart_ready(uuid) TO zeros_app;
GRANT EXECUTE ON FUNCTION cloud_workspace_accepted_lifecycle(uuid,uuid) TO zeros_app;
