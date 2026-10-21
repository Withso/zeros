-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- An initial setup can finish after Delete admission. This receipt completes
-- only its previously unregistered source; it grants no save or dispatch proof.
CREATE TABLE cloud_workspace_initial_delete_captures (
  lifecycle_intent_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation=1),
  setup_run_id uuid NOT NULL,
  workos_required boolean NOT NULL,
  capture_request_id uuid NOT NULL UNIQUE,
  original_recovery jsonb NOT NULL CHECK (jsonb_typeof(original_recovery)='object'),
  bound_recovery jsonb NOT NULL CHECK (jsonb_typeof(bound_recovery)='object'),
  source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256)=32),
  admission_txid bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE
);
ALTER TABLE cloud_workspace_initial_delete_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_initial_delete_captures FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_workspace_initial_delete_captures USING(app_is_system()) WITH CHECK(app_is_system());
-- zeros-expand-exception: initial-delete-capture-privileges Only validated append-only source receipts are application writable
REVOKE ALL ON cloud_workspace_initial_delete_captures FROM PUBLIC,zeros_app;
GRANT SELECT,INSERT ON cloud_workspace_initial_delete_captures TO zeros_app;

CREATE FUNCTION cloud_initial_delete_capture_source(target_intent_id uuid,check_workos boolean DEFAULT true) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT jsonb_build_object('setupRunId',s.id,'workosRequired',check_workos,'original',to_jsonb(r),'bound',to_jsonb(r)||jsonb_build_object(
    'engine_instance_id',e.id,'registered_at',e.registered_at,'registration_token_sha256',e.heartbeat_token_hash,
    'runtime_id',e.runtime_id,'boot_id',boot.boot_id,'writer_epoch',boot.writer_epoch,
    'funding_owner_user_id',boot.funding_owner_user_id,'funding_owner_epoch',boot.funding_owner_epoch))
  -- During admission's deferred check, validate the same original snapshot
  -- against current source authority. A committed receipt cannot re-enroll.
  FROM cloud_workspace_final_save_recoveries current_recovery
  LEFT JOIN cloud_workspace_initial_delete_captures admitted ON admitted.lifecycle_intent_id=current_recovery.lifecycle_intent_id
  CROSS JOIN LATERAL jsonb_populate_record(NULL::cloud_workspace_final_save_recoveries,
    CASE WHEN admitted.admission_txid=txid_current() THEN admitted.original_recovery ELSE to_jsonb(current_recovery) END) r
  JOIN cloud_workspace_lifecycle_intents i ON i.id=r.lifecycle_intent_id AND i.workspace_id=r.workspace_id
    AND i.org_id=r.org_id AND i.generation=r.generation
  JOIN cloud_workspaces w ON w.id=r.workspace_id AND w.org_id=r.org_id
  JOIN cloud_workspace_generations g ON g.workspace_id=w.id AND g.org_id=w.org_id AND g.generation=1
  JOIN cloud_workspace_provider_bindings b ON b.workspace_id=g.workspace_id AND b.org_id=g.org_id AND b.generation=g.generation
  JOIN cloud_workspace_engine_instances e ON e.workspace_id=w.id AND e.org_id=w.org_id AND e.generation=1
  JOIN cloud_workspace_setup_runs s ON s.id=e.setup_run_id AND s.workspace_id=w.id AND s.org_id=w.org_id
    AND s.generation=1 AND s.execution_fence=e.setup_execution_fence
  JOIN cloud_agent_boot_bindings boot ON boot.id=w.agent_boot_id AND boot.workspace_id=w.id AND boot.org_id=w.org_id
    AND boot.engine_instance_id=e.id AND boot.generation=1 AND boot.boot_id=e.runtime_boot_id
  JOIN cloud_workspace_local_command_writers writer ON writer.workspace_id=w.id AND writer.org_id=w.org_id
    AND writer.generation=1 AND writer.engine_instance_id=e.id AND writer.boot_id=boot.boot_id AND writer.writer_epoch=boot.writer_epoch
  JOIN managed_compute_allocation_leases lease ON lease.id=r.allocation_lease_id AND lease.workspace_id=w.id AND lease.org_id=w.org_id
    AND lease.generation=1 AND lease.provider_resource_id=b.provider_resource_id
  JOIN cloud_workspace_lifecycle_intents creation ON creation.id=lease.lifecycle_intent_id
    AND creation.workspace_id=w.id AND creation.org_id=w.org_id AND creation.generation=1
  WHERE r.lifecycle_intent_id=target_intent_id AND r.generation=1 AND r.operation='delete'
    AND r.state IN ('capturing','blocked') AND r.registered_at IS NULL AND r.registration_token_sha256 IS NULL
    AND r.boot_id IS NULL AND r.writer_epoch IS NULL AND r.funding_owner_user_id IS NULL AND r.funding_owner_epoch IS NULL
    AND r.original_request_id IS NULL AND r.current_request_id IS NULL AND r.attempt_ordinal=0
    AND r.custody_id IS NULL AND r.checkpoint_id IS NULL AND r.proven_request_id IS NULL
    AND (r.engine_instance_id=e.id OR (r.engine_instance_id IS NULL AND e.created_at>=i.created_at))
    AND (r.runtime_id=e.runtime_id OR (r.runtime_id IS NULL AND r.engine_instance_id IS NULL))
    AND r.provider_resource_id=b.provider_resource_id AND r.authority_epoch=w.authority_epoch
    AND i.operation='delete' AND i.state='queued' AND i.attempt_count=0 AND i.dispatched_at IS NULL
    AND i.lease_owner IS NULL AND i.lease_expires_at IS NULL AND i.completed_at IS NULL
    AND i.affects_workspace AND i.requested_by=w.owner_user_id AND i.generation_transition_id IS NULL AND i.resume_after_intent_id IS NULL
    AND w.current_generation=1 AND w.accepted_lifecycle_intent_id=i.id AND w.desired_state='running'
    AND w.status IN ('ready','busy') AND w.deleted_at IS NULL AND w.data_deleted_at IS NULL AND w.agent_funding_owner_epoch=1
    AND e.state='ready' AND e.revoked_at IS NULL AND e.registered_at>=i.created_at AND e.lease_expires_at>clock_timestamp()
    AND e.final_checkpoint_at IS NULL AND e.final_save_version=1 AND e.cloud_local_commands_version=1
    AND e.account_user_id=w.owner_user_id AND e.runtime_id=g.runtime_id
    AND s.attempt=1 AND s.execution_fence=1 AND s.claim_count=1 AND s.created_at<=i.created_at
    AND s.state='succeeded' AND s.completed_at>=e.registered_at AND s.lease_owner IS NULL AND s.lease_expires_at IS NULL
    AND boot.created_at>=i.created_at AND boot.retired_at IS NULL AND boot.funding_owner_user_id=w.owner_user_id
    AND boot.funding_owner_epoch=w.agent_funding_owner_epoch AND writer.funding_owner_user_id=boot.funding_owner_user_id
    AND writer.funding_owner_epoch=boot.funding_owner_epoch AND writer.created_at>=i.created_at
    AND writer.state='active' AND writer.activated_at>=i.created_at AND writer.retired_at IS NULL
    AND lease.state IN ('active','draining') AND lease.user_id=w.owner_user_id
    AND creation.operation='create' AND creation.state='succeeded' AND creation.requested_by=w.owner_user_id
    AND creation.completed_at<=i.created_at
    AND cloud_workspace_runtime_authority_live(w.id,1,e.account_user_id,check_workos)
    AND lease.id=(SELECT latest.id FROM managed_compute_allocation_leases latest WHERE latest.workspace_id=w.id AND latest.org_id=w.org_id
      AND latest.provider_resource_id=b.provider_resource_id ORDER BY latest.created_at DESC,latest.id LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_allocation_owners a WHERE a.workspace_id=w.id AND a.org_id=w.org_id
      AND a.provider_resource_id=b.provider_resource_id AND (a.current_generation<>1 OR a.allocation_lease_id<>lease.id))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_engine_instances other WHERE other.workspace_id=w.id AND other.org_id=w.org_id AND other.id<>e.id)
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_setup_runs other WHERE other.workspace_id=w.id AND other.org_id=w.org_id AND other.id<>s.id)
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_local_command_writers other WHERE other.workspace_id=w.id AND other.org_id=w.org_id AND other.writer_epoch<>writer.writer_epoch)
    AND NOT EXISTS (SELECT 1 FROM cloud_agent_boot_bindings other WHERE other.workspace_id=w.id AND other.org_id=w.org_id AND other.id<>boot.id)
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents other WHERE other.workspace_id=w.id AND other.org_id=w.org_id
      AND other.id NOT IN (i.id,creation.id))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_generation_transitions t WHERE t.workspace_id=w.id AND t.org_id=w.org_id)
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_runtime_transitions t WHERE t.workspace_id=w.id AND t.org_id=w.org_id)
    AND NOT EXISTS (SELECT 1 FROM workspace_fork_intents f WHERE f.target_cloud_workspace_id=w.id AND f.org_id=w.org_id)
    AND NOT EXISTS (SELECT 1 FROM workspace_checkpoint_requests q WHERE q.workspace_id=w.id AND q.org_id=w.org_id
      AND q.id IS DISTINCT FROM admitted.capture_request_id)
    AND NOT EXISTS (SELECT 1 FROM workspace_checkpoints c WHERE c.workspace_id=w.id AND c.org_id=w.org_id)
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches d WHERE d.workspace_id=w.id AND d.org_id=w.org_id)
    AND (admitted.lifecycle_intent_id IS NULL OR admitted.admission_txid=txid_current())
$$;

CREATE FUNCTION guard_cloud_initial_delete_capture() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM cloud_workspaces WHERE id=OLD.workspace_id AND org_id=OLD.org_id) THEN RETURN OLD; END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'initial Delete capture receipt is immutable' USING ERRCODE='55000'; END IF;
  PERFORM id FROM organizations WHERE id=NEW.org_id FOR SHARE;
  PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE;
  PERFORM id FROM cloud_workspace_lifecycle_intents WHERE id=NEW.lifecycle_intent_id FOR UPDATE;
  PERFORM lifecycle_intent_id FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=NEW.lifecycle_intent_id FOR UPDATE;
  PERFORM generation FROM cloud_workspace_generations WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id ORDER BY generation FOR SHARE;
  PERFORM generation FROM cloud_workspace_provider_bindings WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id ORDER BY generation FOR SHARE;
  PERFORM id FROM cloud_workspace_setup_runs WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id ORDER BY id FOR SHARE;
  PERFORM id FROM cloud_workspace_engine_instances WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id ORDER BY enrollment_order FOR UPDATE;
  PERFORM id FROM cloud_agent_boot_bindings WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id ORDER BY id FOR UPDATE;
  PERFORM writer_epoch FROM cloud_workspace_local_command_writers WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id ORDER BY writer_epoch FOR UPDATE;
  PERFORM id FROM managed_compute_allocation_leases WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id ORDER BY id FOR SHARE;
  source=cloud_initial_delete_capture_source(NEW.lifecycle_intent_id,NEW.workos_required);
  IF source IS NULL OR NEW.original_recovery IS DISTINCT FROM source->'original' OR NEW.bound_recovery IS DISTINCT FROM source->'bound'
    OR NEW.setup_run_id::text IS DISTINCT FROM source->>'setupRunId'
    OR NEW.workspace_id::text IS DISTINCT FROM source->'original'->>'workspace_id'
    OR NEW.org_id::text IS DISTINCT FROM source->'original'->>'org_id' OR NEW.generation<>1
    OR NEW.source_sha256 IS DISTINCT FROM digest(convert_to(source::text,'UTF8'),'sha256')
    OR NEW.admission_txid<>txid_current() THEN
    RAISE EXCEPTION 'initial Delete capture source changed' USING ERRCODE='40001';
  END IF;
  NEW.created_at=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_initial_delete_capture_immutable BEFORE INSERT OR UPDATE OR DELETE ON cloud_workspace_initial_delete_captures
  FOR EACH ROW EXECUTE FUNCTION guard_cloud_initial_delete_capture();
-- zeros-expand-exception: truncate-guard Retain first-source enrollment history
CREATE TRIGGER cloud_initial_delete_capture_no_truncate BEFORE TRUNCATE ON cloud_workspace_initial_delete_captures
  FOR EACH STATEMENT EXECUTE FUNCTION guard_cloud_initial_delete_capture();

CREATE FUNCTION require_cloud_initial_delete_capture() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF digest(convert_to(cloud_initial_delete_capture_source(NEW.lifecycle_intent_id,NEW.workos_required)::text,'UTF8'),'sha256')
      IS DISTINCT FROM NEW.source_sha256 THEN
    RAISE EXCEPTION 'initial Delete capture authority changed' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries r
    JOIN workspace_checkpoint_requests q ON q.id=NEW.capture_request_id AND q.lifecycle_intent_id=r.lifecycle_intent_id
      AND q.workspace_id=r.workspace_id AND q.org_id=r.org_id AND q.generation=r.generation
    JOIN cloud_workspaces w ON w.id=r.workspace_id AND w.org_id=r.org_id
    JOIN cloud_workspace_lifecycle_intents i ON i.id=r.lifecycle_intent_id
    JOIN cloud_workspace_engine_instances e ON e.id=r.engine_instance_id AND e.workspace_id=w.id AND e.org_id=w.org_id
    JOIN cloud_agent_boot_bindings b ON b.id=w.agent_boot_id AND b.engine_instance_id=e.id
    JOIN cloud_workspace_local_command_writers writer ON writer.workspace_id=w.id AND writer.writer_epoch=b.writer_epoch
    WHERE r.lifecycle_intent_id=NEW.lifecycle_intent_id AND r.original_request_id=q.id AND r.current_request_id=q.id
      AND r.attempt_ordinal=0 AND r.state='capturing' AND r.next_attempt_at=q.deadline_at
      AND to_jsonb(r)-ARRAY['original_request_id','current_request_id','state','next_attempt_at','updated_at']
        =NEW.bound_recovery-ARRAY['original_request_id','current_request_id','state','next_attempt_at','updated_at']
      AND q.reason='before_delete' AND q.state='queued' AND q.delivery_count=0 AND q.last_delivered_at IS NULL
      AND q.final_save_recovery_id=r.lifecycle_intent_id AND q.final_save_attempt_ordinal=0 AND q.deadline_at>clock_timestamp()
      AND q.idempotency_key='initial-delete.'||r.lifecycle_intent_id::text
      AND w.current_generation=1 AND w.accepted_lifecycle_intent_id=i.id AND w.status IN ('ready','busy') AND w.desired_state='running'
      AND w.authority_epoch=r.authority_epoch AND w.owner_user_id=r.funding_owner_user_id AND w.agent_funding_owner_epoch=r.funding_owner_epoch
      AND i.state='queued' AND i.attempt_count=0 AND i.dispatched_at IS NULL AND i.requested_by=w.owner_user_id
      AND e.state='ready' AND e.revoked_at IS NULL AND e.registered_at=r.registered_at AND e.heartbeat_token_hash=r.registration_token_sha256
      AND e.runtime_id=r.runtime_id AND e.runtime_boot_id=r.boot_id AND e.lease_expires_at>clock_timestamp()
      AND b.boot_id=r.boot_id AND b.writer_epoch=r.writer_epoch AND b.retired_at IS NULL
      AND writer.engine_instance_id=e.id AND writer.boot_id=r.boot_id AND writer.state='active' AND writer.activated_at IS NOT NULL
      AND writer.retired_at IS NULL AND cloud_workspace_runtime_authority_live(w.id,1,e.account_user_id,NEW.workos_required)) THEN
    RAISE EXCEPTION 'initial Delete capture must commit atomically' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cloud_initial_delete_capture_atomic AFTER INSERT ON cloud_workspace_initial_delete_captures
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cloud_initial_delete_capture();

-- zeros-expand-exception: initial-delete-source One exact first binding, with the complete previous recovery retained
CREATE OR REPLACE FUNCTION cloud_final_save_source_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF ROW(NEW.lifecycle_intent_id,NEW.workspace_id,NEW.org_id,NEW.generation,NEW.operation,NEW.engine_instance_id,
    NEW.registered_at,NEW.registration_token_sha256,NEW.runtime_id,NEW.boot_id,NEW.writer_epoch,NEW.funding_owner_user_id,
    NEW.funding_owner_epoch,NEW.authority_epoch,NEW.allocation_lease_id,NEW.provider_resource_id)
    IS DISTINCT FROM ROW(OLD.lifecycle_intent_id,OLD.workspace_id,OLD.org_id,OLD.generation,OLD.operation,OLD.engine_instance_id,
    OLD.registered_at,OLD.registration_token_sha256,OLD.runtime_id,OLD.boot_id,OLD.writer_epoch,OLD.funding_owner_user_id,
    OLD.funding_owner_epoch,OLD.authority_epoch,OLD.allocation_lease_id,OLD.provider_resource_id) AND NOT EXISTS (
      SELECT 1 FROM cloud_workspace_initial_delete_captures receipt WHERE receipt.lifecycle_intent_id=OLD.lifecycle_intent_id
        AND receipt.admission_txid=txid_current() AND receipt.original_recovery=to_jsonb(OLD) AND receipt.bound_recovery=to_jsonb(NEW)) THEN
    RAISE EXCEPTION 'immutable final save source' USING ERRCODE='23514';
  END IF;
  IF (OLD.original_request_id IS NOT NULL AND NEW.original_request_id IS DISTINCT FROM OLD.original_request_id)
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

CREATE FUNCTION admit_cloud_initial_delete_capture(target_intent_id uuid,expected_source_sha256 bytea DEFAULT NULL,check_workos boolean DEFAULT true) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scope record; source jsonb; receipt cloud_workspace_initial_delete_captures; bound cloud_workspace_final_save_recoveries;
BEGIN
  SELECT workspace_id,org_id INTO scope FROM cloud_workspace_lifecycle_intents WHERE id=target_intent_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM id FROM organizations WHERE id=scope.org_id FOR SHARE;
  PERFORM id FROM cloud_workspaces WHERE id=scope.workspace_id AND org_id=scope.org_id FOR UPDATE;
  PERFORM id FROM cloud_workspace_lifecycle_intents WHERE id=target_intent_id FOR UPDATE;
  PERFORM lifecycle_intent_id FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=target_intent_id FOR UPDATE;
  SELECT * INTO receipt FROM cloud_workspace_initial_delete_captures WHERE lifecycle_intent_id=target_intent_id;
  IF FOUND THEN
    IF expected_source_sha256 IS NOT NULL AND expected_source_sha256<>receipt.source_sha256 THEN
      RAISE EXCEPTION 'initial Delete capture plan changed' USING ERRCODE='40001';
    END IF;
    RETURN receipt.capture_request_id;
  END IF;
  source=cloud_initial_delete_capture_source(target_intent_id,check_workos);
  IF source IS NULL THEN RETURN NULL; END IF;
  IF expected_source_sha256 IS NOT NULL AND expected_source_sha256<>digest(convert_to(source::text,'UTF8'),'sha256') THEN
    RAISE EXCEPTION 'initial Delete capture plan changed' USING ERRCODE='40001';
  END IF;
  INSERT INTO cloud_workspace_initial_delete_captures(lifecycle_intent_id,workspace_id,org_id,generation,setup_run_id,workos_required,
    capture_request_id,original_recovery,bound_recovery,source_sha256)
    VALUES(target_intent_id,scope.workspace_id,scope.org_id,1,(source->>'setupRunId')::uuid,check_workos,gen_random_uuid(),
      source->'original',source->'bound',digest(convert_to(source::text,'UTF8'),'sha256')) RETURNING * INTO receipt;
  bound=jsonb_populate_record(NULL::cloud_workspace_final_save_recoveries,receipt.bound_recovery);
  UPDATE cloud_workspace_final_save_recoveries SET engine_instance_id=bound.engine_instance_id,registered_at=bound.registered_at,
    registration_token_sha256=bound.registration_token_sha256,runtime_id=bound.runtime_id,boot_id=bound.boot_id,writer_epoch=bound.writer_epoch,
    funding_owner_user_id=bound.funding_owner_user_id,funding_owner_epoch=bound.funding_owner_epoch WHERE lifecycle_intent_id=target_intent_id;
  INSERT INTO workspace_checkpoint_requests(id,workspace_id,org_id,generation,requested_by,lifecycle_intent_id,reason,idempotency_key,deadline_at)
    SELECT receipt.capture_request_id,scope.workspace_id,scope.org_id,1,requested_by,target_intent_id,'before_delete',
      'initial-delete.'||target_intent_id::text,clock_timestamp()+interval '5 minutes'
    FROM cloud_workspace_lifecycle_intents WHERE id=target_intent_id;
  UPDATE cloud_workspace_final_save_recoveries SET state='capturing',updated_at=clock_timestamp() WHERE lifecycle_intent_id=target_intent_id;
  PERFORM pg_notify('zeros_cloud_checkpoint_request',scope.workspace_id::text||':1');
  RETURN receipt.capture_request_id;
END $$;

-- zeros-expand-exception: privilege-tightening Restrict capture admission to the application and migration roles
REVOKE ALL ON FUNCTION cloud_initial_delete_capture_source(uuid,boolean),guard_cloud_initial_delete_capture(),
  require_cloud_initial_delete_capture(),admit_cloud_initial_delete_capture(uuid,bytea,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_initial_delete_capture_source(uuid,boolean),admit_cloud_initial_delete_capture(uuid,bytea,boolean) TO zeros_app;
