-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A failed replacement which never admitted a native writer has no final
-- history to save. This distinct receipt is NOT checkpoint proof and is only
-- available within an already owner-attested checkpoint-recovery transition.
CREATE TABLE cloud_workspace_unstarted_candidate_cleanup (
  lifecycle_intent_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation>0),
  operation text NOT NULL CHECK (operation IN ('stop','delete')),
  transition_id uuid NOT NULL,
  owner_discard_receipt_id uuid NOT NULL,
  checkpoint_id uuid NOT NULL,
  record_batch_id uuid,
  engine_instance_id uuid NOT NULL,
  setup_run_id uuid NOT NULL,
  registered_at timestamptz NOT NULL,
  registration_token_sha256 bytea NOT NULL CHECK (octet_length(registration_token_sha256)=32),
  runtime_id text NOT NULL,
  boot_id uuid NOT NULL,
  provider_resource_id text NOT NULL,
  allocation_lease_id uuid NOT NULL,
  recovery_sha256 bytea NOT NULL CHECK (octet_length(recovery_sha256)=32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE
);
CREATE INDEX cloud_unstarted_candidate_scope ON cloud_workspace_unstarted_candidate_cleanup(workspace_id,org_id,generation);
CREATE INDEX cloud_unstarted_candidate_resource ON cloud_workspace_unstarted_candidate_cleanup(workspace_id,org_id,provider_resource_id);
CREATE INDEX cloud_owner_discard_candidate ON cloud_workspace_owner_discard_receipts(workspace_id,org_id,candidate_generation);
ALTER TABLE cloud_workspace_unstarted_candidate_cleanup ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_unstarted_candidate_cleanup FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_workspace_unstarted_candidate_cleanup USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT,INSERT ON cloud_workspace_unstarted_candidate_cleanup TO zeros_app;
-- zeros-expand-exception: new-table-privileges Remove default mutable privileges from the new immutable cleanup receipt
REVOKE UPDATE,DELETE,TRUNCATE ON cloud_workspace_unstarted_candidate_cleanup FROM PUBLIC,zeros_app;

-- zeros-expand-exception: widen-check Retain all saved and discarded states and add only receipt-backed absence of admitted work
ALTER TABLE cloud_workspace_final_save_recoveries DROP CONSTRAINT cloud_workspace_final_save_recoveries_state_check;
ALTER TABLE cloud_workspace_final_save_recoveries ADD CONSTRAINT cloud_workspace_final_save_recoveries_state_check
  CHECK (state IN ('capturing','retrying','reconciling','blocked','proven','resolved','discarded','not_required'));

-- Return exact evidence, not a status-based exemption. Re-used at INSERT and
-- after provider/cache awaits. A current generation, successful setup, any
-- boot/writer/command/capture, replacement enrollment or moved binding refuses.
CREATE FUNCTION cloud_unstarted_candidate_source(target_intent_id uuid)
RETURNS SETOF cloud_workspace_unstarted_candidate_cleanup
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT intent.id,intent.workspace_id,intent.org_id,intent.generation,intent.operation::text,
    transition.id,owner.id,checkpoint.id,restored_record.id,engine.id,setup.id,engine.registered_at,engine.heartbeat_token_hash,
    engine.runtime_id,engine.runtime_boot_id,binding.provider_resource_id,lease.id,
    digest(convert_to(jsonb_build_array(recovery.lifecycle_intent_id,recovery.workspace_id,recovery.org_id,recovery.generation,recovery.operation,
      recovery.original_request_id,recovery.current_request_id,recovery.attempt_ordinal,recovery.engine_instance_id,
      extract(epoch from recovery.registered_at),recovery.registration_token_sha256,recovery.runtime_id,recovery.boot_id,recovery.writer_epoch,
      recovery.funding_owner_user_id,recovery.funding_owner_epoch,recovery.authority_epoch,recovery.allocation_lease_id,
      recovery.provider_resource_id,recovery.custody_id)::text,'UTF8'),'sha256'),clock_timestamp()
  FROM cloud_workspace_lifecycle_intents intent
  JOIN cloud_workspace_final_save_recoveries recovery ON recovery.lifecycle_intent_id=intent.id
    AND recovery.workspace_id=intent.workspace_id AND recovery.org_id=intent.org_id AND recovery.generation=intent.generation
  JOIN cloud_workspaces workspace ON workspace.id=intent.workspace_id AND workspace.org_id=intent.org_id
  JOIN cloud_workspace_owner_discard_receipts owner ON owner.workspace_id=workspace.id AND owner.org_id=workspace.org_id
    AND owner.candidate_generation=intent.generation
  JOIN cloud_workspace_generation_transitions transition ON transition.id=owner.transition_id
    AND transition.workspace_id=workspace.id AND transition.org_id=workspace.org_id
    AND transition.source_generation=owner.source_generation AND transition.candidate_generation=intent.generation
  JOIN cloud_workspace_generations generation ON generation.workspace_id=workspace.id AND generation.org_id=workspace.org_id
    AND generation.generation=intent.generation AND generation.recovery_checkpoint_id=owner.checkpoint_id
  JOIN workspace_checkpoints checkpoint ON checkpoint.id=owner.checkpoint_id
    AND checkpoint.workspace_id=workspace.id AND checkpoint.org_id=workspace.org_id
  JOIN cloud_workspace_engine_instances engine ON engine.id=recovery.engine_instance_id
    AND engine.workspace_id=workspace.id AND engine.org_id=workspace.org_id AND engine.generation=intent.generation
  JOIN cloud_workspace_setup_runs setup ON setup.id=engine.setup_run_id AND setup.workspace_id=workspace.id
    AND setup.org_id=workspace.org_id AND setup.generation=intent.generation AND setup.execution_fence=engine.setup_execution_fence
  JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=workspace.id AND binding.org_id=workspace.org_id
    AND binding.generation=intent.generation AND binding.provider_resource_id=recovery.provider_resource_id
  JOIN managed_compute_allocation_leases lease ON lease.id=recovery.allocation_lease_id
    AND lease.workspace_id=workspace.id AND lease.org_id=workspace.org_id AND lease.generation=intent.generation
    AND lease.provider_resource_id=binding.provider_resource_id
  -- Initial record sync precedes native history restoration. The sole allowed
  -- write is the restored primary metadata with its local creation timestamp
  -- normalized; every other field must equal the retained checkpoint source.
  -- Record rows are immutable, and the receipt freezes this exact batch ID.
  LEFT JOIN LATERAL (
    SELECT records.id FROM workspace_record_batches records
    JOIN workspace_record_events event ON event.batch_id=records.id AND event.workspace_id=records.workspace_id
      AND event.org_id=records.org_id AND event.revision=records.first_revision
    JOIN LATERAL (SELECT previous.* FROM workspace_record_events previous
      WHERE previous.workspace_id=records.workspace_id AND previous.org_id=records.org_id
        AND previous.entity_kind='metadata' AND previous.entity_id='primary-workspace-v1'
        AND previous.revision<=checkpoint.record_revision ORDER BY previous.revision DESC LIMIT 1) source ON true
    WHERE records.workspace_id=workspace.id AND records.org_id=workspace.org_id AND records.generation=intent.generation
      AND records.source_kind='engine' AND records.engine_instance_id=engine.id
      AND records.created_at>=engine.registered_at AND records.created_at<=setup.completed_at AND records.created_at<=engine.revoked_at
      AND records.first_revision=checkpoint.record_revision+1 AND records.last_revision=records.first_revision AND records.event_count=1
      AND (SELECT count(*) FROM workspace_record_events member WHERE member.batch_id=records.id
        AND member.workspace_id=records.workspace_id AND member.org_id=records.org_id)=1
      AND event.entity_kind='metadata' AND event.entity_id='primary-workspace-v1' AND event.operation='upsert' AND event.schema_version=1
      AND source.operation='upsert' AND source.schema_version=1 AND source.document->'version'='1'::jsonb
      AND event.document-'createdAt'=source.document-'createdAt'
      AND CASE WHEN jsonb_typeof(event.document->'createdAt')='number' THEN (event.document->>'createdAt')::numeric>=0 ELSE false END
      AND CASE WHEN jsonb_typeof(source.document->'createdAt')='number' THEN (source.document->>'createdAt')::numeric>=0 ELSE false END
  ) restored_record ON true
  WHERE intent.id=target_intent_id AND intent.operation IN ('stop','delete') AND intent.requested_by IS NULL
    AND NOT intent.affects_workspace AND workspace.current_generation<>intent.generation
    AND transition.operation='recover' AND transition.execution_mode='replace_allocation' AND transition.state='rollback_failed'
    AND transition.error_code='setup_checkpoint_restore_invalid' AND transition.completed_at IS NOT NULL
    AND ((intent.operation='delete' AND intent.generation_transition_id=transition.id)
      OR (intent.operation='stop' AND intent.generation_transition_id IS NULL
        AND intent.idempotency_key LIKE 'system:compute-stop:%' AND lease.stop_intent_id=intent.id))
    AND generation.runtime_id=owner.runtime_id AND engine.runtime_id=generation.runtime_id
    AND engine.state='revoked' AND engine.revoked_at IS NOT NULL AND engine.final_checkpoint_at IS NULL
    AND engine.cloud_local_commands_version=1 AND engine.runtime_boot_id IS NOT NULL
    AND engine.registered_at=recovery.registered_at AND engine.heartbeat_token_hash=recovery.registration_token_sha256
    AND recovery.runtime_id=engine.runtime_id AND recovery.boot_id IS NULL AND recovery.writer_epoch IS NULL
    AND recovery.custody_id IS NULL AND recovery.attempt_ordinal=0 AND recovery.checkpoint_id IS NULL AND recovery.proven_request_id IS NULL
    AND recovery.state NOT IN ('proven','resolved','discarded')
    AND setup.state='failed' AND setup.completed_at IS NOT NULL AND setup.error_code='setup_checkpoint_restore_invalid'
    AND setup.lease_owner IS NULL AND setup.lease_expires_at IS NULL
    AND checkpoint.state='durable' AND checkpoint.invalidated_at IS NULL AND checkpoint.durable_at=owner.checkpoint_at
    AND checkpoint.integrity_sha256=owner.checkpoint_sha256 AND checkpoint.content_revision=owner.checkpoint_content_revision
    AND checkpoint.record_revision=owner.checkpoint_record_revision AND checkpoint.retention_until>clock_timestamp()
    AND EXISTS (SELECT 1 FROM workspace_blobs blob WHERE blob.id=checkpoint.manifest_blob_id
      AND blob.state='available' AND blob.org_id=workspace.org_id)
    AND (checkpoint.artifact_blob_id IS NULL OR EXISTS (SELECT 1 FROM workspace_blobs blob WHERE blob.id=checkpoint.artifact_blob_id
      AND blob.state='available' AND blob.org_id=workspace.org_id))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_engine_instances other WHERE other.workspace_id=workspace.id
      AND other.org_id=workspace.org_id AND other.generation=intent.generation AND other.id<>engine.id)
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_setup_runs other WHERE other.workspace_id=workspace.id
      AND other.org_id=workspace.org_id AND other.generation=intent.generation AND other.id<>setup.id
      AND other.state IN ('queued','running','succeeded'))
    AND NOT EXISTS (SELECT 1 FROM cloud_agent_boot_bindings boot WHERE boot.workspace_id=workspace.id
      AND boot.org_id=workspace.org_id AND boot.generation=intent.generation)
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_local_command_writers writer WHERE writer.workspace_id=workspace.id
      AND writer.org_id=workspace.org_id AND writer.generation=intent.generation)
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_commands command WHERE command.workspace_id=workspace.id
      AND command.org_id=workspace.org_id AND command.generation=intent.generation)
    AND NOT EXISTS (SELECT 1 FROM workspace_checkpoints newer WHERE newer.workspace_id=workspace.id
      AND newer.org_id=workspace.org_id AND newer.generation=intent.generation)
    AND NOT EXISTS (SELECT 1 FROM workspace_record_batches records WHERE records.workspace_id=workspace.id
      AND records.org_id=workspace.org_id AND records.generation=intent.generation
      AND (restored_record.id IS NULL OR records.id<>restored_record.id))
    AND NOT EXISTS (SELECT 1 FROM workspace_content_revisions content WHERE content.workspace_id=workspace.id
      AND content.org_id=workspace.org_id AND content.generation=intent.generation)
    AND NOT EXISTS (SELECT 1 FROM workspace_checkpoint_requests request WHERE request.workspace_id=workspace.id
      AND request.org_id=workspace.org_id AND request.generation=intent.generation
      AND (request.delivery_count<>0 OR request.last_delivered_at IS NOT NULL OR request.checkpoint_id IS NOT NULL
        OR request.final_save_capture_report IS NOT NULL OR request.final_save_commit_report IS NOT NULL
        OR request.final_save_reconcile_report IS NOT NULL))
    AND recovery.allocation_lease_id IS NOT DISTINCT FROM (SELECT latest.id FROM managed_compute_allocation_leases latest
      WHERE latest.workspace_id=workspace.id AND latest.org_id=workspace.org_id AND latest.provider_resource_id=binding.provider_resource_id
      ORDER BY latest.created_at DESC,latest.id LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_allocation_owners allocation WHERE allocation.workspace_id=workspace.id
      AND allocation.org_id=workspace.org_id AND allocation.provider_resource_id=binding.provider_resource_id
      AND (allocation.current_generation<>intent.generation OR allocation.allocation_lease_id<>lease.id))
$$;

CREATE FUNCTION cloud_unstarted_candidate_current(target_intent_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM cloud_workspace_unstarted_candidate_cleanup receipt
    JOIN LATERAL cloud_unstarted_candidate_source(receipt.lifecycle_intent_id) source
      ON (to_jsonb(receipt)-'created_at')=(to_jsonb(source)-'created_at')
    WHERE receipt.lifecycle_intent_id=target_intent_id)
$$;

CREATE FUNCTION guard_cloud_unstarted_candidate_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source cloud_workspace_unstarted_candidate_cleanup;
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM cloud_workspaces WHERE id=OLD.workspace_id AND org_id=OLD.org_id) THEN RETURN OLD; END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'candidate cleanup receipts are append-only' USING ERRCODE='55000'; END IF;
  PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE;
  SELECT * INTO source FROM cloud_unstarted_candidate_source(NEW.lifecycle_intent_id);
  IF NOT FOUND OR (to_jsonb(NEW)-'created_at') IS DISTINCT FROM (to_jsonb(source)-'created_at')
    OR NOT EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents intent WHERE intent.id=NEW.lifecycle_intent_id
      AND intent.state IN ('queued','observing') AND intent.attempt_count=0 AND intent.dispatched_at IS NULL)
    OR EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches dispatch WHERE dispatch.workspace_id=NEW.workspace_id
      AND dispatch.org_id=NEW.org_id AND dispatch.generation=NEW.generation
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_unstarted_candidate_cleanup prior WHERE prior.lifecycle_intent_id=dispatch.lifecycle_intent_id)) THEN
    RAISE EXCEPTION 'candidate cleanup evidence changed' USING ERRCODE='40001';
  END IF;
  NEW.created_at=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_unstarted_candidate_append_only BEFORE INSERT OR UPDATE OR DELETE ON cloud_workspace_unstarted_candidate_cleanup
  FOR EACH ROW EXECUTE FUNCTION guard_cloud_unstarted_candidate_receipt();
-- zeros-expand-exception: truncate-guard Prevent truncation from removing immutable candidate cleanup custody
CREATE TRIGGER cloud_unstarted_candidate_no_truncate BEFORE TRUNCATE ON cloud_workspace_unstarted_candidate_cleanup
  FOR EACH STATEMENT EXECUTE FUNCTION guard_cloud_unstarted_candidate_receipt();

CREATE FUNCTION require_cloud_unstarted_candidate_retirement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT cloud_unstarted_candidate_current(NEW.lifecycle_intent_id) OR NOT EXISTS (
    SELECT 1 FROM cloud_workspace_final_save_recoveries recovery WHERE recovery.lifecycle_intent_id=NEW.lifecycle_intent_id
      AND recovery.state='not_required' AND recovery.next_attempt_at='infinity') OR EXISTS (
    SELECT 1 FROM workspace_checkpoint_requests request WHERE request.final_save_recovery_id=NEW.lifecycle_intent_id
      AND (request.state NOT IN ('failed','expired','cancelled') OR request.final_save_retirement_id IS NULL)) THEN
    RAISE EXCEPTION 'candidate cleanup must retire its capture atomically' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cloud_unstarted_candidate_retirement AFTER INSERT ON cloud_workspace_unstarted_candidate_cleanup
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cloud_unstarted_candidate_retirement();

-- An N-1 retry/expiry cannot reopen capture or deliver after this disposition.
-- The first, never-delivered queued request may be truthfully cancelled once;
-- every existing report, failure, request and retirement identity is retained.
CREATE FUNCTION cloud_unstarted_candidate_hold_capture() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='cloud_workspace_final_save_recoveries' THEN
    IF NEW.state='not_required' AND (TG_OP='INSERT' OR NOT EXISTS (
      SELECT 1 FROM cloud_workspace_unstarted_candidate_cleanup WHERE lifecycle_intent_id=NEW.lifecycle_intent_id)) THEN
      RAISE EXCEPTION 'candidate cleanup receipt required' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND EXISTS (SELECT 1 FROM cloud_workspace_unstarted_candidate_cleanup WHERE lifecycle_intent_id=OLD.lifecycle_intent_id) THEN
      NEW=OLD; NEW.state='not_required'; NEW.next_attempt_at='infinity';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM cloud_workspace_unstarted_candidate_cleanup WHERE lifecycle_intent_id=NEW.final_save_recovery_id) THEN
    IF TG_OP='INSERT' OR NEW.state IN ('queued','delivered','recovery_queued','recovery_delivered') THEN
      RAISE EXCEPTION 'candidate capture is retired' USING ERRCODE='40001';
    END IF;
    IF OLD.state IN ('queued','recovery_queued') AND OLD.delivery_count=0 AND NEW.state='cancelled'
      AND NEW.error_code='candidate_never_started' THEN RETURN NEW; END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zzz_cloud_unstarted_candidate_hold_recovery BEFORE INSERT OR UPDATE ON cloud_workspace_final_save_recoveries
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_capture();
CREATE TRIGGER zzz_cloud_unstarted_candidate_hold_attempt BEFORE INSERT OR UPDATE ON workspace_checkpoint_requests
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_capture();

CREATE FUNCTION adopt_cloud_unstarted_candidate_cleanup(target_intent_id uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE changed integer;
BEGIN
  PERFORM workspace.id FROM cloud_workspaces workspace JOIN cloud_workspace_lifecycle_intents intent
    ON intent.workspace_id=workspace.id AND intent.org_id=workspace.org_id WHERE intent.id=target_intent_id FOR UPDATE OF workspace;
  IF EXISTS (SELECT 1 FROM cloud_workspace_unstarted_candidate_cleanup WHERE lifecycle_intent_id=target_intent_id) THEN
    RETURN cloud_unstarted_candidate_current(target_intent_id);
  END IF;
  INSERT INTO cloud_workspace_unstarted_candidate_cleanup SELECT source.* FROM cloud_unstarted_candidate_source(target_intent_id) source
    JOIN cloud_workspace_lifecycle_intents intent ON intent.id=source.lifecycle_intent_id
    WHERE intent.state IN ('queued','observing') AND intent.attempt_count=0 AND intent.dispatched_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches held
        WHERE held.workspace_id=source.workspace_id AND held.org_id=source.org_id AND held.generation=source.generation
          AND NOT EXISTS (SELECT 1 FROM cloud_workspace_unstarted_candidate_cleanup prior WHERE prior.lifecycle_intent_id=held.lifecycle_intent_id));
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed=0 THEN RETURN false; END IF;
  UPDATE cloud_workspace_final_save_recoveries SET state='not_required',next_attempt_at='infinity' WHERE lifecycle_intent_id=target_intent_id;
  UPDATE workspace_checkpoint_requests SET state='cancelled',completed_at=clock_timestamp(),error_code='candidate_never_started'
    WHERE final_save_recovery_id=target_intent_id AND state IN ('queued','recovery_queued') AND delivery_count=0;
  INSERT INTO audit_log(org_id,actor_id,action,subject)
    SELECT org_id,NULL,'cloud_workspace.unstarted_candidate_cleanup',jsonb_build_object('workspaceId',workspace_id,
      'generation',generation,'intentId',lifecycle_intent_id,'transitionId',transition_id,'ownerReceiptId',owner_discard_receipt_id,
      'engineInstanceId',engine_instance_id,'reason','candidate_never_started')
    FROM cloud_workspace_unstarted_candidate_cleanup WHERE lifecycle_intent_id=target_intent_id;
  PERFORM enqueue_cloud_lifecycle_job('cloud_lifecycle_intent',workspace_id,org_id,clock_timestamp())
    FROM cloud_workspace_unstarted_candidate_cleanup WHERE lifecycle_intent_id=target_intent_id;
  RETURN true;
END $$;

-- The immutable owner receipt exists before any candidate enrollment. Only
-- its candidate mutations take this parent lock, including BEFORE the cleanup
-- receipt exists, so a concurrent boot/registration cannot race an absence
-- check. Normal workspace mutations do one indexed no-op lookup.
CREATE FUNCTION cloud_unstarted_candidate_hold_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scope_id uuid; scope_org uuid; scope_generation integer; resource_id text; changed boolean;
BEGIN
  IF TG_TABLE_NAME='cloud_workspaces' THEN
    scope_id=NEW.id; scope_org=NEW.org_id; scope_generation=NEW.current_generation;
    changed=NEW.current_generation IS DISTINCT FROM OLD.current_generation;
  ELSE
    scope_id=NEW.workspace_id; scope_org=NEW.org_id;
    IF TG_TABLE_NAME='cloud_workspace_generation_transitions' THEN scope_generation=NEW.candidate_generation;
    ELSIF TG_TABLE_NAME='cloud_workspace_allocation_owners' THEN scope_generation=NEW.current_generation; resource_id=NEW.provider_resource_id;
    ELSIF TG_TABLE_NAME='workspace_record_events' THEN
      SELECT generation INTO scope_generation FROM workspace_record_batches
        WHERE id=NEW.batch_id AND workspace_id=scope_id AND org_id=scope_org;
    ELSE scope_generation=NEW.generation; END IF;
    IF TG_TABLE_NAME IN ('cloud_workspace_provider_bindings','managed_compute_allocation_leases') THEN resource_id=NEW.provider_resource_id; END IF;
    changed=TG_OP='INSERT';
    IF TG_OP='UPDATE' THEN
      IF TG_TABLE_NAME='cloud_workspace_engine_instances' THEN
        changed=ROW(NEW.state,NEW.revoked_at,NEW.registered_at,NEW.last_heartbeat_at,NEW.lease_expires_at,NEW.heartbeat_token_hash,
          NEW.runtime_id,NEW.runtime_boot_id,NEW.cloud_local_commands_version,NEW.setup_run_id,NEW.setup_execution_fence)
          IS DISTINCT FROM ROW(OLD.state,OLD.revoked_at,OLD.registered_at,OLD.last_heartbeat_at,OLD.lease_expires_at,OLD.heartbeat_token_hash,
          OLD.runtime_id,OLD.runtime_boot_id,OLD.cloud_local_commands_version,OLD.setup_run_id,OLD.setup_execution_fence);
      ELSIF TG_TABLE_NAME='cloud_workspace_provider_bindings' THEN
        changed=ROW(NEW.provider,NEW.provider_resource_id,NEW.workspace_id,NEW.org_id,NEW.generation)
          IS DISTINCT FROM ROW(OLD.provider,OLD.provider_resource_id,OLD.workspace_id,OLD.org_id,OLD.generation);
      ELSIF TG_TABLE_NAME='managed_compute_allocation_leases' THEN
        changed=ROW(NEW.provider_resource_id,NEW.generation) IS DISTINCT FROM ROW(OLD.provider_resource_id,OLD.generation);
      ELSIF TG_TABLE_NAME='cloud_workspace_allocation_owners' THEN
        changed=ROW(NEW.current_generation,NEW.allocation_lease_id,NEW.provider_resource_id)
          IS DISTINCT FROM ROW(OLD.current_generation,OLD.allocation_lease_id,OLD.provider_resource_id);
      ELSE changed=(to_jsonb(NEW)-ARRAY['updated_at','retired_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at','retired_at']); END IF;
    END IF;
  END IF;
  IF NOT changed THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM cloud_workspace_owner_discard_receipts owner WHERE owner.workspace_id=scope_id
    AND owner.org_id=scope_org AND owner.candidate_generation=scope_generation) OR EXISTS (
    SELECT 1 FROM cloud_workspace_unstarted_candidate_cleanup receipt WHERE receipt.workspace_id=scope_id AND receipt.org_id=scope_org
      AND receipt.provider_resource_id=resource_id) THEN
    PERFORM id FROM cloud_workspaces WHERE id=scope_id AND org_id=scope_org FOR UPDATE NOWAIT;
    IF EXISTS (SELECT 1 FROM cloud_workspace_unstarted_candidate_cleanup receipt WHERE receipt.workspace_id=scope_id AND receipt.org_id=scope_org
      AND (receipt.generation=scope_generation OR receipt.provider_resource_id=resource_id)) THEN
      RAISE EXCEPTION 'never-started candidate is retired' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_unstarted_hold_workspace BEFORE UPDATE OF current_generation ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_source();
CREATE TRIGGER cloud_unstarted_hold_engine BEFORE INSERT OR UPDATE ON cloud_workspace_engine_instances
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_source();
CREATE TRIGGER cloud_unstarted_hold_setup BEFORE INSERT OR UPDATE ON cloud_workspace_setup_runs
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_source();
CREATE TRIGGER cloud_unstarted_hold_boot BEFORE INSERT OR UPDATE ON cloud_agent_boot_bindings
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_source();
CREATE TRIGGER cloud_unstarted_hold_writer BEFORE INSERT OR UPDATE ON cloud_workspace_local_command_writers
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_source();
CREATE TRIGGER cloud_unstarted_hold_command BEFORE INSERT OR UPDATE ON cloud_workspace_commands
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_source();
CREATE TRIGGER cloud_unstarted_hold_checkpoint BEFORE INSERT OR UPDATE ON workspace_checkpoints
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_source();
CREATE TRIGGER cloud_unstarted_hold_records BEFORE INSERT OR UPDATE ON workspace_record_batches
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_source();
CREATE TRIGGER cloud_unstarted_hold_record_events BEFORE INSERT OR UPDATE ON workspace_record_events
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_source();
CREATE TRIGGER cloud_unstarted_hold_content BEFORE INSERT OR UPDATE ON workspace_content_revisions
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_source();
CREATE TRIGGER cloud_unstarted_hold_generation BEFORE UPDATE ON cloud_workspace_generations
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_source();
CREATE TRIGGER cloud_unstarted_hold_transition BEFORE UPDATE ON cloud_workspace_generation_transitions
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_source();
CREATE TRIGGER cloud_unstarted_hold_binding BEFORE INSERT OR UPDATE ON cloud_workspace_provider_bindings
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_source();
CREATE TRIGGER cloud_unstarted_hold_lease BEFORE INSERT OR UPDATE ON managed_compute_allocation_leases
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_source();
CREATE TRIGGER cloud_unstarted_hold_allocation BEFORE INSERT OR UPDATE ON cloud_workspace_allocation_owners
  FOR EACH ROW EXECUTE FUNCTION cloud_unstarted_candidate_hold_source();

CREATE FUNCTION cloud_final_save_dispatchable(target_intent_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT cloud_final_save_proven(target_intent_id) OR cloud_unstarted_candidate_current(target_intent_id)
$$;
-- zeros-expand-exception: candidate-dispatch Admit only real final proof or the exact never-started candidate receipt
CREATE OR REPLACE FUNCTION cloud_final_save_require_dispatch() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.operation IN ('stop','archive','delete') AND NEW.state='dispatching' THEN
    PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE;
    IF NOT cloud_final_save_dispatchable(NEW.id) THEN
      RAISE EXCEPTION 'final save proof is required before dispatch' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- zeros-expand-exception: privilege-tightening Close public execution of new cleanup authority and trigger functions
REVOKE ALL ON FUNCTION cloud_unstarted_candidate_source(uuid),cloud_unstarted_candidate_current(uuid),guard_cloud_unstarted_candidate_receipt(),
  cloud_unstarted_candidate_hold_capture(),adopt_cloud_unstarted_candidate_cleanup(uuid),cloud_unstarted_candidate_hold_source(),
  cloud_final_save_dispatchable(uuid),require_cloud_unstarted_candidate_retirement() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_unstarted_candidate_source(uuid),cloud_unstarted_candidate_current(uuid),
  adopt_cloud_unstarted_candidate_cleanup(uuid),cloud_final_save_dispatchable(uuid) TO zeros_app;

-- Physical erasure is still downstream of every provider generation, the
-- saved current generation, active dispatches, job custody and legal holds.
-- zeros-expand-exception: candidate-history Omit only immutable never-started receipts from unresolved historical saves
CREATE OR REPLACE FUNCTION cloud_final_save_deletion_claimable(target_workspace_id uuid,target_org_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries
      WHERE workspace_id=target_workspace_id AND org_id=target_org_id AND state NOT IN ('proven','resolved')
        AND NOT cloud_final_save_owner_discarded(lifecycle_intent_id)
        AND NOT EXISTS (SELECT 1 FROM cloud_workspace_unstarted_candidate_cleanup receipt
          WHERE receipt.lifecycle_intent_id=cloud_workspace_final_save_recoveries.lifecycle_intent_id))
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

-- zeros-expand-exception: candidate-purge Retain job custody and physical erasure gates while honoring only exact never-started history
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
        WHERE recovery.workspace_id=target_workspace_id AND recovery.org_id=target_org_id AND recovery.state NOT IN ('proven','resolved')
          AND NOT cloud_final_save_owner_discarded(recovery.lifecycle_intent_id)
          AND NOT EXISTS (SELECT 1 FROM cloud_workspace_unstarted_candidate_cleanup receipt
            WHERE receipt.lifecycle_intent_id=recovery.lifecycle_intent_id))
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
