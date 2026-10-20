-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- An exact, never-delivered safety Stop may race provider loss attestation.
-- These nullable companions leave existing receipts and ordinary B proof intact.
ALTER TABLE cloud_workspace_owner_discard_receipts ADD COLUMN safety_stop_intent_id uuid UNIQUE;
ALTER TABLE cloud_workspace_owner_discard_receipts ADD COLUMN safety_request_id uuid UNIQUE;
ALTER TABLE cloud_workspace_owner_discard_receipts ADD COLUMN safety_source_sha256 bytea;
ALTER TABLE cloud_workspace_owner_discard_receipts ADD COLUMN loss_inventory_sha256 bytea;
ALTER TABLE cloud_workspace_owner_discard_receipts ADD COLUMN loss_inventory_observed_at timestamptz;
ALTER TABLE cloud_workspace_owner_discard_receipts ADD COLUMN loss_lookup_observed_at timestamptz;
ALTER TABLE cloud_workspace_owner_discard_receipts ADD COLUMN loss_provider_account text;
ALTER TABLE cloud_workspace_owner_discard_receipts ADD COLUMN loss_inventory_resource_count integer;
ALTER TABLE cloud_workspace_owner_discard_receipts ADD CONSTRAINT owner_discard_safety_companion CHECK (
  num_nonnulls(safety_stop_intent_id,safety_request_id,safety_source_sha256) IN (0,3)
  AND (safety_stop_intent_id IS NULL OR (safety_stop_intent_id<>stop_intent_id AND safety_stop_intent_id<>wake_intent_id
    AND safety_request_id<>request_id AND octet_length(safety_source_sha256)=32)));
ALTER TABLE cloud_workspace_owner_discard_receipts ADD CONSTRAINT owner_discard_loss_observation CHECK (
  num_nonnulls(loss_inventory_sha256,loss_inventory_observed_at,loss_lookup_observed_at,loss_provider_account,loss_inventory_resource_count) IN (0,5)
  AND (loss_inventory_sha256 IS NULL OR (octet_length(loss_inventory_sha256)=32
    AND length(loss_provider_account) BETWEEN 1 AND 256 AND loss_inventory_resource_count>=0)));

-- DB canonical encoding binds the second recovery's entire frozen source.
-- Counters, retry scheduling and ordinary expiry never confer new authority.
CREATE FUNCTION cloud_owner_discard_recovery_digest(target_intent_id uuid) RETURNS bytea
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT digest(convert_to(jsonb_build_array(lifecycle_intent_id,workspace_id,org_id,generation,operation,
    original_request_id,current_request_id,attempt_ordinal,engine_instance_id,extract(epoch from registered_at),registration_token_sha256,
    runtime_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch,authority_epoch,allocation_lease_id,
    provider_resource_id,custody_id)::text,'UTF8'),'sha256')
  FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=target_intent_id
$$;

-- Positive lineage from the real safety-stop producer: exact lease pointer,
-- same native source, the wake's transaction timestamp, and its audit receipt.
-- The settled lease and never-delivered request have no outstanding native I/O.
CREATE FUNCTION cloud_owner_discard_safety_stop_matches(
  target_workspace_id uuid,target_org_id uuid,target_generation integer,
  original_stop_id uuid,original_wake_id uuid,safety_stop_id uuid,safety_request_id uuid,safety_digest bytea
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents original
    JOIN cloud_workspace_lifecycle_intents wake ON wake.resume_after_intent_id=original.id
    JOIN cloud_workspace_final_save_recoveries held ON held.lifecycle_intent_id=original.id
    JOIN cloud_workspace_lifecycle_intents safety ON safety.id=safety_stop_id
    JOIN cloud_workspace_final_save_recoveries recovery ON recovery.lifecycle_intent_id=safety.id
    JOIN workspace_checkpoint_requests request ON request.id=safety_request_id
    JOIN managed_compute_allocation_leases lease ON lease.id=held.allocation_lease_id
    WHERE original.id=original_stop_id AND wake.id=original_wake_id
      AND original.workspace_id=target_workspace_id AND original.org_id=target_org_id AND original.generation=target_generation
      AND NOT original.affects_workspace AND wake.state='superseded' AND wake.completed_at=safety.created_at
      AND wake.error_code='provider_not_found'
      AND safety.workspace_id=original.workspace_id AND safety.org_id=original.org_id AND safety.generation=original.generation
      AND safety.operation='stop' AND safety.requested_by IS NULL AND safety.affects_workspace
      AND safety.idempotency_key LIKE 'system:compute-stop:%'
      AND safety.state IN ('queued','observing') AND safety.attempt_count=0 AND safety.dispatched_at IS NULL
      AND safety.lease_owner IS NULL AND safety.generation_transition_id IS NULL AND safety.resume_after_intent_id IS NULL
      AND safety.created_at>original.created_at
      AND recovery.workspace_id=original.workspace_id AND recovery.org_id=original.org_id AND recovery.generation=original.generation
      AND recovery.operation='stop' AND recovery.state IN ('capturing','retrying','blocked') AND recovery.attempt_ordinal=0
      AND recovery.original_request_id=request.id AND recovery.current_request_id=request.id
      AND recovery.custody_id IS NULL AND recovery.checkpoint_id IS NULL AND recovery.proven_request_id IS NULL
      AND ROW(recovery.engine_instance_id,recovery.registered_at,recovery.registration_token_sha256,recovery.runtime_id,
        recovery.boot_id,recovery.writer_epoch,recovery.funding_owner_user_id,recovery.funding_owner_epoch,
        recovery.allocation_lease_id,recovery.provider_resource_id)
        IS NOT DISTINCT FROM ROW(held.engine_instance_id,held.registered_at,held.registration_token_sha256,held.runtime_id,
        held.boot_id,held.writer_epoch,held.funding_owner_user_id,held.funding_owner_epoch,held.allocation_lease_id,held.provider_resource_id)
      AND cloud_owner_discard_recovery_digest(safety.id)=safety_digest
      AND request.lifecycle_intent_id=safety.id AND request.final_save_recovery_id=safety.id AND request.final_save_attempt_ordinal=0
      AND request.workspace_id=original.workspace_id AND request.org_id=original.org_id AND request.generation=original.generation
      AND request.reason='before_stop' AND request.requested_by IS NULL AND request.delivery_count=0 AND request.last_delivered_at IS NULL
      AND request.state IN ('queued','cancelled','expired','failed') AND request.checkpoint_id IS NULL
      AND request.final_save_capture_report IS NULL AND request.final_save_commit_report IS NULL AND request.final_save_reconcile_report IS NULL
      AND lease.workspace_id=original.workspace_id AND lease.org_id=original.org_id AND lease.generation=original.generation
      AND lease.provider_resource_id=held.provider_resource_id AND lease.stop_intent_id=safety.id
      AND lease.state='settled' AND lease.settled_at IS NOT NULL AND lease.lease_owner IS NULL
      AND EXISTS (SELECT 1 FROM audit_log audit WHERE audit.org_id=original.org_id AND audit.actor_id IS NULL
        AND audit.action='cloud_workspace.compute_stop_requested' AND audit.created_at=safety.created_at
        AND audit.subject->>'workspaceId'=original.workspace_id::text AND audit.subject->>'intentId'=safety.id::text
        AND audit.subject->>'leaseId'=lease.id::text AND audit.subject->>'checkpointRequestId'=request.id::text
        AND audit.subject->>'reason'=wake.error_code)
      AND NOT EXISTS (SELECT 1 FROM workspace_checkpoint_requests other
        WHERE other.final_save_recovery_id=safety.id AND other.id<>request.id))
$$;

-- zeros-expand-exception: owner-discard-safety-guard Preserve original pins and add exact safety lineage plus fresh receipt evidence
CREATE OR REPLACE FUNCTION guard_cloud_owner_discard_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM cloud_workspaces WHERE id=OLD.workspace_id AND org_id=OLD.org_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'owner discard receipts are append-only' USING ERRCODE='55000'; END IF;
  IF current_user='zeros_app' OR NEW.database_principal<>current_user
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.cloud_workspace_owner_discard_receipts'::regclass
      AND pg_get_userbyid(relowner)=current_user) THEN
    RAISE EXCEPTION 'owner discard requires the migration owner' USING ERRCODE='42501';
  END IF;
  PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE;
  IF NEW.safety_stop_intent_id IS NOT NULL AND NOT cloud_owner_discard_safety_stop_matches(
    NEW.workspace_id,NEW.org_id,NEW.source_generation,NEW.stop_intent_id,NEW.wake_intent_id,
    NEW.safety_stop_intent_id,NEW.safety_request_id,NEW.safety_source_sha256) THEN
    RAISE EXCEPTION 'owner discard safety Stop changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents intent
    WHERE intent.workspace_id=NEW.workspace_id AND intent.org_id=NEW.org_id
      AND intent.state IN ('queued','observing','dispatching')
      AND intent.id<>NEW.stop_intent_id AND intent.id<>NEW.wake_intent_id
      AND intent.id IS DISTINCT FROM NEW.safety_stop_intent_id)
    OR EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries recovery
      WHERE recovery.workspace_id=NEW.workspace_id AND recovery.org_id=NEW.org_id AND recovery.generation=NEW.source_generation
        AND recovery.state NOT IN ('proven','resolved') AND recovery.lifecycle_intent_id<>NEW.stop_intent_id
        AND recovery.lifecycle_intent_id IS DISTINCT FROM NEW.safety_stop_intent_id) THEN
    RAISE EXCEPTION 'owner discard has additional lifecycle work' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cloud_workspaces workspace
    JOIN cloud_workspace_final_save_recoveries recovery ON recovery.workspace_id=workspace.id AND recovery.org_id=workspace.org_id
    JOIN cloud_workspace_lifecycle_intents stop ON stop.id=recovery.lifecycle_intent_id
    JOIN cloud_workspace_lifecycle_intents wake ON wake.resume_after_intent_id=stop.id
    JOIN workspace_checkpoint_requests request ON request.id=recovery.current_request_id
    JOIN workspace_checkpoints checkpoint ON checkpoint.id=NEW.checkpoint_id
    JOIN workspace_content_heads head ON head.workspace_id=workspace.id AND head.org_id=workspace.org_id
    JOIN cloud_workspace_provider_loss_attestations loss ON loss.id=NEW.provider_loss_attestation_id
    JOIN users operator ON operator.id=NEW.operator_user_id AND operator.auth_status='active'
      AND operator.deleted_at IS NULL AND operator.staff_role='platform_owner'
    WHERE workspace.id=NEW.workspace_id AND workspace.org_id=NEW.org_id AND workspace.current_generation=NEW.source_generation
      AND workspace.owner_user_id=NEW.owner_user_id AND workspace.deleted_at IS NULL AND workspace.desired_state<>'deleted'
      AND recovery.lifecycle_intent_id=NEW.stop_intent_id AND recovery.generation=NEW.source_generation AND recovery.operation='stop'
      AND recovery.state NOT IN ('proven','resolved') AND recovery.checkpoint_id IS NULL AND recovery.proven_request_id IS NULL
      AND recovery.custody_id=NEW.custody_id AND recovery.provider_resource_id=NEW.provider_resource_id
      AND stop.operation='stop' AND stop.state IN ('queued','observing') AND stop.requested_by=NEW.owner_user_id
      AND stop.attempt_count=0 AND stop.dispatched_at IS NULL AND stop.lease_owner IS NULL AND stop.generation_transition_id IS NULL
      AND wake.id=NEW.wake_intent_id AND wake.workspace_id=workspace.id AND wake.org_id=workspace.org_id
      AND wake.generation=NEW.source_generation AND wake.operation='wake' AND wake.restart_version=1
      AND (wake.state IN ('queued','observing') OR (NEW.safety_stop_intent_id IS NOT NULL AND wake.state='superseded'))
      AND wake.attempt_count=0 AND wake.dispatched_at IS NULL AND wake.lease_owner IS NULL
      AND wake.requested_by=NEW.owner_user_id AND wake.generation_transition_id IS NULL
      AND request.id=NEW.request_id AND request.final_save_recovery_id=recovery.lifecycle_intent_id
      AND request.final_save_retirement_id=NEW.retirement_id AND request.final_save_attempt_ordinal=recovery.attempt_ordinal
      AND request.state IN ('expired','failed','cancelled') AND request.checkpoint_id IS NULL
      AND request.final_save_commit_report IS NULL
      AND request.final_save_capture_report->>'sourceSha256'=encode(NEW.source_sha256,'hex')
      AND request.final_save_reconcile_report->>'sourceSha256'=encode(NEW.source_sha256,'hex')
      AND request.final_save_reconcile_report->'commit'='null'::jsonb
      AND checkpoint.workspace_id=workspace.id AND checkpoint.org_id=workspace.org_id AND checkpoint.generation=NEW.source_generation
      AND checkpoint.state='durable' AND checkpoint.invalidated_at IS NULL AND head.current_checkpoint_id=checkpoint.id
      AND checkpoint.integrity_sha256=NEW.checkpoint_sha256 AND checkpoint.content_revision=NEW.checkpoint_content_revision
      AND checkpoint.record_revision=NEW.checkpoint_record_revision AND checkpoint.durable_at=NEW.checkpoint_at
      AND loss.workspace_id=workspace.id AND loss.generation=NEW.source_generation AND loss.resource_id=NEW.provider_resource_id
      AND ((NEW.loss_inventory_sha256 IS NULL
        AND loss.lookup_observed_at BETWEEN clock_timestamp()-interval '15 minutes' AND clock_timestamp()
        AND loss.inventory_observed_at BETWEEN clock_timestamp()-interval '15 minutes' AND clock_timestamp())
        OR (NEW.loss_provider_account=loss.provider_account AND NEW.loss_inventory_sha256 IS NOT NULL
          AND NEW.loss_lookup_observed_at BETWEEN clock_timestamp()-interval '15 minutes' AND clock_timestamp()
          AND NEW.loss_inventory_observed_at BETWEEN clock_timestamp()-interval '15 minutes' AND clock_timestamp()))
      AND cloud_provider_allocation_lost(workspace.id,NEW.source_generation,workspace.org_id,NEW.provider_resource_id)
  ) OR EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches
    WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id AND settled_at IS NULL)
    OR EXISTS (SELECT 1 FROM cloud_workspace_engine_instances WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id
      AND generation=NEW.source_generation AND state IN ('starting','ready') AND revoked_at IS NULL AND lease_expires_at>clock_timestamp())
  THEN RAISE EXCEPTION 'owner discard target or custody changed' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;

-- zeros-expand-exception: owner-discard-safety-disposition Extend the exact receipt disposition only to its named safety Stop
CREATE OR REPLACE FUNCTION cloud_final_save_owner_discarded(target_intent_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM cloud_workspace_owner_discard_receipts WHERE stop_intent_id=target_intent_id OR safety_stop_intent_id=target_intent_id)
$$;

-- zeros-expand-exception: owner-discard-safety-retirement Keep all named intents retired without granting dispatch authority
CREATE OR REPLACE FUNCTION cloud_owner_discard_retire_intent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt cloud_workspace_owner_discard_receipts;
BEGIN
  SELECT * INTO receipt FROM cloud_workspace_owner_discard_receipts
    WHERE workspace_id=OLD.workspace_id AND org_id=OLD.org_id AND source_generation=OLD.generation
      AND (stop_intent_id=OLD.id OR wake_intent_id=OLD.id OR safety_stop_intent_id=OLD.id);
  IF FOUND THEN
    IF ROW(NEW.id,NEW.workspace_id,NEW.org_id,NEW.generation,NEW.operation,NEW.idempotency_key,NEW.request_sha256)
      IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.org_id,OLD.generation,OLD.operation,OLD.idempotency_key,OLD.request_sha256) THEN
      RAISE EXCEPTION 'discarded lifecycle identity is immutable' USING ERRCODE='23514';
    END IF;
    NEW.state='superseded'; NEW.completed_at=coalesce(OLD.completed_at,receipt.created_at);
    NEW.affects_workspace=CASE WHEN NEW.operation='stop' THEN false ELSE OLD.affects_workspace END;
    NEW.lease_owner=NULL; NEW.lease_expires_at=NULL;
    NEW.error_code='owner_discarded'; NEW.error_message='Owner explicitly chose recovery from the named durable checkpoint';
  END IF;
  RETURN NEW;
END $$;

-- zeros-expand-exception: owner-discard-safety-transition Require atomic retirement of the second recovery in the same pinned transition
CREATE OR REPLACE FUNCTION require_cloud_owner_discard_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cloud_workspace_generation_transitions transition
    JOIN cloud_workspace_generations generation ON generation.workspace_id=transition.workspace_id
      AND generation.org_id=transition.org_id AND generation.generation=transition.candidate_generation
    JOIN cloud_workspace_computer_sources computer ON computer.workspace_id=generation.workspace_id
      AND computer.org_id=generation.org_id AND computer.generation=generation.generation
    JOIN cloud_workspace_lifecycle_intents stop ON stop.id=NEW.stop_intent_id
    JOIN cloud_workspace_lifecycle_intents wake ON wake.id=NEW.wake_intent_id
    JOIN cloud_workspace_final_save_recoveries recovery ON recovery.lifecycle_intent_id=NEW.stop_intent_id
    WHERE transition.id=NEW.transition_id AND transition.workspace_id=NEW.workspace_id AND transition.org_id=NEW.org_id
      AND transition.operation='recover' AND transition.execution_mode='replace_allocation'
      AND transition.source_generation=NEW.source_generation AND transition.candidate_generation=NEW.candidate_generation
      AND transition.drain_intent_id=NEW.stop_intent_id AND transition.state='provisioning'
      AND generation.recovery_checkpoint_id=NEW.checkpoint_id AND generation.runtime_id=NEW.runtime_id
      AND computer.build_id=NEW.computer_build_id AND computer.config_id=NEW.computer_config_id
      AND stop.state='superseded' AND wake.state='superseded'
      AND recovery.state='discarded' AND recovery.next_attempt_at='infinity'::timestamptz
      AND recovery.checkpoint_id IS NULL AND recovery.proven_request_id IS NULL)
    OR (NEW.safety_stop_intent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM cloud_workspace_lifecycle_intents safety
      JOIN cloud_workspace_final_save_recoveries recovery ON recovery.lifecycle_intent_id=safety.id
      JOIN workspace_checkpoint_requests request ON request.id=NEW.safety_request_id
      WHERE safety.id=NEW.safety_stop_intent_id AND safety.workspace_id=NEW.workspace_id AND safety.org_id=NEW.org_id
        AND safety.generation=NEW.source_generation AND safety.state='superseded' AND NOT safety.affects_workspace
        AND recovery.state='discarded' AND recovery.next_attempt_at='infinity'::timestamptz
        AND recovery.checkpoint_id IS NULL AND recovery.proven_request_id IS NULL AND recovery.custody_id IS NULL
        AND request.final_save_recovery_id=safety.id AND request.state IN ('cancelled','expired','failed')
        AND request.final_save_retirement_id IS NOT NULL AND request.delivery_count=0 AND request.last_delivered_at IS NULL
        AND request.final_save_capture_report IS NULL AND request.final_save_commit_report IS NULL AND request.final_save_reconcile_report IS NULL)) THEN
    RAISE EXCEPTION 'owner discard requires its exact recovery transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
-- These are private owner-receipt predicates, not an application admission API.
-- zeros-expand-exception: privilege-tightening Keep the new owner-only predicates private
REVOKE ALL ON FUNCTION cloud_owner_discard_recovery_digest(uuid),
  cloud_owner_discard_safety_stop_matches(uuid,uuid,integer,uuid,uuid,uuid,uuid,bytea) FROM PUBLIC;
