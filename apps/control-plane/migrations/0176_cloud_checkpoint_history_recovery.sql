-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A lost VM plus the exact owner discard is positive source retirement. It
-- is not a successful Stop, a native ACK, or permission to discard elsewhere.
-- zeros-expand-exception: widen-check Keep both existing retirement proofs and add exact owner discard
ALTER TABLE cloud_agent_credential_source_retirements DROP CONSTRAINT cloud_agent_credential_source_retirements_proof_kind_check;
ALTER TABLE cloud_agent_credential_source_retirements ADD CONSTRAINT cloud_agent_credential_source_retirements_proof_kind_check
  CHECK (proof_kind IN ('provider-lifecycle','resident-consumed','owner-discard'));

-- Retrying a never-started candidate is a new operator action. The original
-- discard and failed transition stay immutable, and its Stop is never reused
-- as another drain or relabelled successful.
CREATE TABLE cloud_workspace_owner_recovery_retries (
  id uuid PRIMARY KEY,
  owner_discard_receipt_id uuid NOT NULL REFERENCES cloud_workspace_owner_discard_receipts(id),
  workspace_id uuid NOT NULL, org_id uuid NOT NULL, source_generation integer NOT NULL CHECK(source_generation>0),
  failed_transition_id uuid NOT NULL UNIQUE, failed_candidate_generation integer NOT NULL,
  cleanup_stop_intent_id uuid NOT NULL, cleanup_delete_intent_id uuid NOT NULL,
  transition_id uuid NOT NULL UNIQUE, candidate_generation integer NOT NULL,
  checkpoint_id uuid NOT NULL, computer_build_id uuid NOT NULL, computer_config_id uuid NOT NULL,
  runtime_id text NOT NULL CHECK(runtime_id ~ '^r1-[a-f0-9]{64}$'),
  owner_user_id uuid NOT NULL, operator_user_id uuid NOT NULL,
  owner_approval_reference text NOT NULL CHECK(length(owner_approval_reference) BETWEEN 16 AND 512),
  reason text NOT NULL CHECK(length(reason) BETWEEN 16 AND 512),
  request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),
  plan_sha256 bytea NOT NULL CHECK(octet_length(plan_sha256)=32),
  target_fingerprint text NOT NULL CHECK(target_fingerprint ~ '^[a-f0-9]{64}$'),
  database_principal text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(source_generation<failed_candidate_generation AND failed_candidate_generation<candidate_generation),
  CHECK(cleanup_stop_intent_id<>cleanup_delete_intent_id AND id<>owner_discard_receipt_id AND transition_id<>failed_transition_id),
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE
);
CREATE INDEX cloud_owner_recovery_retry_scope ON cloud_workspace_owner_recovery_retries(workspace_id,org_id,source_generation);
ALTER TABLE cloud_workspace_owner_recovery_retries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_owner_recovery_retries FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_workspace_owner_recovery_retries USING(app_is_system()) WITH CHECK(app_is_system());
-- zeros-expand-exception: new-table-privileges Only the migration owner may admit an explicit retry
REVOKE ALL ON cloud_workspace_owner_recovery_retries FROM PUBLIC,zeros_app;
GRANT SELECT ON cloud_workspace_owner_recovery_retries TO zeros_app;

CREATE FUNCTION cloud_owner_recovery_retry_ready(owner_id uuid,failed_id uuid,stop_id uuid,delete_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM cloud_workspace_owner_discard_receipts owner
    JOIN cloud_workspaces workspace ON workspace.id=owner.workspace_id AND workspace.org_id=owner.org_id
    JOIN cloud_workspace_generation_transitions failed ON failed.id=owner.transition_id
      AND failed.workspace_id=workspace.id AND failed.org_id=workspace.org_id AND failed.candidate_generation=owner.candidate_generation
    JOIN cloud_workspace_final_save_recoveries source ON source.lifecycle_intent_id=owner.stop_intent_id
    JOIN cloud_workspace_engine_instances engine ON engine.id=source.engine_instance_id
    JOIN cloud_workspace_unstarted_candidate_cleanup stop ON stop.lifecycle_intent_id=stop_id AND stop.operation='stop'
    JOIN cloud_workspace_unstarted_candidate_cleanup deletion ON deletion.lifecycle_intent_id=delete_id AND deletion.operation='delete'
    JOIN cloud_workspace_lifecycle_intents stop_intent ON stop_intent.id=stop.lifecycle_intent_id
    JOIN cloud_workspace_lifecycle_intents delete_intent ON delete_intent.id=deletion.lifecycle_intent_id
    JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=workspace.id AND binding.org_id=workspace.org_id
      AND binding.generation=failed.candidate_generation AND binding.provider_resource_id=deletion.provider_resource_id
    JOIN managed_compute_allocation_leases lease ON lease.id=deletion.allocation_lease_id
    JOIN workspace_checkpoints checkpoint ON checkpoint.id=owner.checkpoint_id AND checkpoint.workspace_id=workspace.id AND checkpoint.org_id=workspace.org_id
    JOIN workspace_content_heads head ON head.workspace_id=workspace.id AND head.org_id=workspace.org_id
    WHERE owner.id=owner_id AND failed.id=failed_id AND workspace.current_generation=owner.source_generation
      AND workspace.owner_user_id=owner.owner_user_id AND workspace.deleted_at IS NULL AND workspace.desired_state='stopped'
      AND workspace.status IN ('stopped','failed') AND workspace.accepted_lifecycle_intent_id IS NULL
      AND failed.state='rollback_failed' AND failed.operation='recover' AND failed.execution_mode='replace_allocation'
      AND failed.error_code='setup_checkpoint_restore_invalid' AND failed.completed_at IS NOT NULL
      AND source.state='discarded' AND source.checkpoint_id IS NULL AND source.proven_request_id IS NULL
      AND source.funding_owner_user_id=workspace.owner_user_id AND source.funding_owner_epoch=workspace.agent_funding_owner_epoch
      AND engine.state='revoked' AND engine.revoked_at IS NOT NULL AND engine.lease_expires_at<=clock_timestamp()
      AND engine.registered_at=source.registered_at AND engine.heartbeat_token_hash=source.registration_token_sha256
      AND cloud_provider_allocation_lost(workspace.id,owner.source_generation,workspace.org_id,owner.provider_resource_id)
      AND stop.owner_discard_receipt_id=owner.id AND deletion.owner_discard_receipt_id=owner.id
      AND stop.transition_id=failed.id AND deletion.transition_id=failed.id
      AND stop.workspace_id=workspace.id AND stop.org_id=workspace.org_id AND stop.generation=failed.candidate_generation
      AND deletion.workspace_id=workspace.id AND deletion.org_id=workspace.org_id AND deletion.generation=failed.candidate_generation
      AND stop.engine_instance_id=deletion.engine_instance_id AND stop.allocation_lease_id=deletion.allocation_lease_id
      AND stop.provider_resource_id=deletion.provider_resource_id
      AND cloud_unstarted_candidate_current(stop_id) AND cloud_unstarted_candidate_current(delete_id)
      AND stop_intent.state='succeeded' AND delete_intent.state='succeeded'
      AND stop_intent.lease_owner IS NULL AND delete_intent.lease_owner IS NULL
      AND binding.deletion_verified_at IS NOT NULL AND binding.observed_state='deleted'
      AND lease.state='settled' AND lease.settled_at IS NOT NULL AND lease.lease_owner IS NULL
      AND checkpoint.state='durable' AND checkpoint.invalidated_at IS NULL AND checkpoint.retention_until>clock_timestamp()
      AND checkpoint.integrity_sha256=owner.checkpoint_sha256 AND checkpoint.content_revision=owner.checkpoint_content_revision
      AND checkpoint.record_revision=owner.checkpoint_record_revision AND checkpoint.durable_at=owner.checkpoint_at
      AND head.current_checkpoint_id=checkpoint.id
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_generations newer WHERE newer.workspace_id=workspace.id AND newer.org_id=workspace.org_id
        AND newer.generation>failed.candidate_generation)
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches dispatch WHERE dispatch.workspace_id=workspace.id
        AND dispatch.org_id=workspace.org_id AND dispatch.settled_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents intent WHERE intent.workspace_id=workspace.id AND intent.org_id=workspace.org_id
        AND intent.state IN ('queued','observing','dispatching'))
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_engine_instances live WHERE live.workspace_id=workspace.id AND live.org_id=workspace.org_id
        AND live.state IN ('starting','ready') AND live.revoked_at IS NULL AND live.lease_expires_at>clock_timestamp()))
$$;

CREATE FUNCTION preserve_cloud_owner_recovery_retry() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM cloud_workspaces WHERE id=OLD.workspace_id AND org_id=OLD.org_id) THEN RETURN OLD; END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'owner recovery retries are immutable' USING ERRCODE='55000'; END IF;
  IF current_user='zeros_app' OR NEW.database_principal<>current_user OR NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid='public.cloud_workspace_owner_recovery_retries'::regclass AND pg_get_userbyid(relowner)=current_user) THEN
    RAISE EXCEPTION 'owner retry requires the migration owner' USING ERRCODE='42501';
  END IF;
  PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE;
  IF NOT cloud_owner_recovery_retry_ready(NEW.owner_discard_receipt_id,NEW.failed_transition_id,NEW.cleanup_stop_intent_id,NEW.cleanup_delete_intent_id)
    OR NOT EXISTS (SELECT 1 FROM cloud_workspace_owner_discard_receipts owner
      JOIN users operator ON operator.id=NEW.operator_user_id AND operator.auth_status='active' AND operator.deleted_at IS NULL
        AND operator.staff_role='platform_owner'
      WHERE owner.id=NEW.owner_discard_receipt_id AND owner.workspace_id=NEW.workspace_id AND owner.org_id=NEW.org_id
        AND owner.owner_user_id=NEW.owner_user_id AND owner.checkpoint_id=NEW.checkpoint_id AND owner.source_generation=NEW.source_generation
        AND owner.transition_id=NEW.failed_transition_id AND owner.candidate_generation=NEW.failed_candidate_generation
        AND NEW.candidate_generation=owner.candidate_generation+1 AND owner.runtime_id<>NEW.runtime_id) THEN
    RAISE EXCEPTION 'owner retry evidence changed' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_owner_recovery_retry_identity BEFORE INSERT OR UPDATE OR DELETE ON cloud_workspace_owner_recovery_retries
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_owner_recovery_retry();
-- zeros-expand-exception: truncate-guard Retain every immutable explicit retry
CREATE TRIGGER cloud_owner_recovery_retry_no_truncate BEFORE TRUNCATE ON cloud_workspace_owner_recovery_retries
  FOR EACH STATEMENT EXECUTE FUNCTION preserve_cloud_owner_recovery_retry();

CREATE FUNCTION require_cloud_owner_recovery_retry_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cloud_workspace_generation_transitions transition
    JOIN cloud_workspace_generations generation ON generation.workspace_id=transition.workspace_id AND generation.org_id=transition.org_id
      AND generation.generation=transition.candidate_generation
    JOIN cloud_workspace_computer_sources computer ON computer.workspace_id=generation.workspace_id AND computer.org_id=generation.org_id
      AND computer.generation=generation.generation
    JOIN cloud_workspace_lifecycle_intents provision ON provision.id=transition.provision_intent_id
    WHERE transition.id=NEW.transition_id AND transition.workspace_id=NEW.workspace_id AND transition.org_id=NEW.org_id
      AND transition.source_generation=NEW.source_generation AND transition.candidate_generation=NEW.candidate_generation
      AND transition.operation='recover' AND transition.execution_mode='replace_allocation' AND transition.state='provisioning'
      AND transition.drain_intent_id IS NULL AND generation.recovery_checkpoint_id=NEW.checkpoint_id AND generation.runtime_id=NEW.runtime_id
      AND computer.build_id=NEW.computer_build_id AND computer.config_id=NEW.computer_config_id
      AND provision.workspace_id=NEW.workspace_id AND provision.org_id=NEW.org_id AND provision.generation=NEW.candidate_generation
      AND provision.operation='create' AND provision.state='queued' AND provision.generation_transition_id=NEW.transition_id) THEN
    RAISE EXCEPTION 'owner retry requires its exact candidate atomically' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER cloud_owner_recovery_retry_transition AFTER INSERT ON cloud_workspace_owner_recovery_retries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cloud_owner_recovery_retry_transition();

CREATE FUNCTION cloud_owner_discard_transition_receipt(transition_id uuid,workspace_id uuid,org_id uuid,source_generation integer) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT owner.id FROM cloud_workspace_owner_discard_receipts owner
  WHERE owner.workspace_id=$2 AND owner.org_id=$3 AND owner.source_generation=$4
    AND (owner.transition_id=$1 OR EXISTS (SELECT 1 FROM cloud_workspace_owner_recovery_retries retry
      WHERE retry.transition_id=$1 AND retry.owner_discard_receipt_id=owner.id AND retry.workspace_id=$2 AND retry.org_id=$3
        AND retry.source_generation=$4 AND retry.checkpoint_id=owner.checkpoint_id))
    AND cloud_provider_allocation_lost(owner.workspace_id,owner.source_generation,owner.org_id,owner.provider_resource_id)
$$;
-- zeros-expand-exception: owner-retry-lost-cleanup Extend only the exact lost-source cleanup suppression to its receipted retry
CREATE OR REPLACE FUNCTION cloud_owner_discard_skip_lost_cleanup() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.operation IN ('stop','delete') AND NEW.requested_by IS NULL AND NOT NEW.affects_workspace
    AND cloud_owner_discard_transition_receipt(NEW.generation_transition_id,NEW.workspace_id,NEW.org_id,NEW.generation) IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION cloud_owner_discard_history_receipt(target_engine_id uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT receipt.id FROM cloud_workspace_engine_instances target
  JOIN cloud_workspaces workspace ON workspace.id=target.workspace_id AND workspace.org_id=target.org_id
  JOIN cloud_workspace_generations generation ON generation.workspace_id=workspace.id AND generation.org_id=workspace.org_id
    AND generation.generation=target.generation
  JOIN cloud_workspace_generation_transitions transition ON transition.workspace_id=workspace.id AND transition.org_id=workspace.org_id
    AND transition.candidate_generation=generation.generation
  JOIN cloud_workspace_owner_discard_receipts receipt ON receipt.id=cloud_owner_discard_transition_receipt(
    transition.id,workspace.id,workspace.org_id,transition.source_generation)
    AND receipt.workspace_id=workspace.id AND receipt.org_id=workspace.org_id
  LEFT JOIN cloud_workspace_owner_recovery_retries retry ON retry.transition_id=transition.id AND retry.owner_discard_receipt_id=receipt.id
  JOIN cloud_workspace_final_save_recoveries recovery ON recovery.lifecycle_intent_id=receipt.stop_intent_id
  JOIN cloud_workspace_engine_instances source ON source.id=recovery.engine_instance_id
    AND source.workspace_id=workspace.id AND source.org_id=workspace.org_id AND source.generation=receipt.source_generation
  JOIN cloud_agent_boot_bindings binding ON binding.engine_instance_id=source.id AND binding.workspace_id=workspace.id
    AND binding.org_id=workspace.org_id AND binding.writer_epoch=recovery.writer_epoch AND binding.boot_id=recovery.boot_id
  JOIN workspace_checkpoints checkpoint ON checkpoint.id=receipt.checkpoint_id AND checkpoint.workspace_id=workspace.id AND checkpoint.org_id=workspace.org_id
  WHERE target.id=target_engine_id AND workspace.deleted_at IS NULL AND workspace.desired_state='running'
    AND workspace.current_generation=target.generation AND target.state='ready' AND target.revoked_at IS NULL
    AND target.lease_expires_at>clock_timestamp() AND target.cloud_local_commands_version=1
    AND target.runtime_id=coalesce(retry.runtime_id,receipt.runtime_id) AND generation.runtime_id=target.runtime_id
    AND generation.recovery_checkpoint_id=receipt.checkpoint_id AND coalesce(retry.candidate_generation,receipt.candidate_generation)=target.generation
    AND transition.operation='recover' AND transition.execution_mode='replace_allocation'
    AND transition.state IN ('provisioning','setting_up','succeeded') AND transition.source_generation=receipt.source_generation
    AND ((retry.id IS NULL AND transition.drain_intent_id=receipt.stop_intent_id) OR (retry.id IS NOT NULL AND transition.drain_intent_id IS NULL))
    AND workspace.owner_user_id=receipt.owner_user_id
    AND recovery.state='discarded' AND recovery.checkpoint_id IS NULL AND recovery.proven_request_id IS NULL
    AND recovery.workspace_id=workspace.id AND recovery.org_id=workspace.org_id AND recovery.generation=receipt.source_generation
    AND source.registered_at=recovery.registered_at AND source.heartbeat_token_hash=recovery.registration_token_sha256
    AND source.runtime_id=recovery.runtime_id AND source.runtime_boot_id=recovery.boot_id
    AND source.state='revoked' AND source.revoked_at IS NOT NULL AND source.lease_expires_at<=clock_timestamp()
    AND target.enrollment_order>source.enrollment_order
    AND binding.funding_owner_user_id=receipt.owner_user_id AND binding.funding_owner_epoch=workspace.agent_funding_owner_epoch
    AND (workspace.agent_boot_id=binding.id OR EXISTS (
      SELECT 1 FROM cloud_agent_history_recoveries history
      JOIN cloud_agent_boot_bindings activated ON activated.id=workspace.agent_boot_id
      WHERE history.engine_instance_id=target.id AND history.predecessor_binding_id=binding.id AND history.activated_at IS NOT NULL
        AND activated.engine_instance_id=target.id AND activated.writer_epoch=history.successor_writer_epoch AND activated.retired_at IS NULL))
    AND checkpoint.state='durable' AND checkpoint.invalidated_at IS NULL AND checkpoint.retention_until>clock_timestamp()
    AND checkpoint.integrity_sha256=receipt.checkpoint_sha256 AND checkpoint.durable_at=receipt.checkpoint_at
    AND checkpoint.content_revision=receipt.checkpoint_content_revision AND checkpoint.record_revision=receipt.checkpoint_record_revision
    AND cloud_provider_allocation_lost(receipt.workspace_id,receipt.source_generation,receipt.org_id,receipt.provider_resource_id)
$$;

-- One canonical projection per recovery, frozen before any successor writer
-- can activate. This retains accepted IDs and latest edit/delete fences; it
-- never asserts complete workspace coverage or reconstructs native authority.
CREATE TABLE cloud_agent_checkpoint_history_snapshots (
  recovery_id uuid PRIMARY KEY REFERENCES cloud_agent_history_recoveries(id) ON DELETE CASCADE,
  owner_discard_receipt_id uuid NOT NULL REFERENCES cloud_workspace_owner_discard_receipts(id),
  checkpoint_id uuid NOT NULL,
  document text NOT NULL CHECK (octet_length(document) BETWEEN 1 AND 16777216 AND jsonb_typeof(document::jsonb)='object'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$' AND sha256=encode(sha256(convert_to(document,'UTF8')),'hex')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION preserve_cloud_checkpoint_history_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM cloud_agent_history_recoveries WHERE id=OLD.recovery_id) THEN RETURN OLD; END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'checkpoint history snapshots are immutable' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cloud_agent_history_recoveries recovery
    JOIN cloud_workspace_owner_discard_receipts receipt ON receipt.id=NEW.owner_discard_receipt_id
    WHERE recovery.id=NEW.recovery_id AND recovery.activated_at IS NULL AND recovery.prepared_custody='[]'::jsonb
      AND receipt.id=cloud_owner_discard_history_receipt(recovery.engine_instance_id) AND receipt.checkpoint_id=NEW.checkpoint_id
      AND NEW.document::jsonb->>'version'='1'
      AND NEW.document::jsonb->'scope'->>'writerEpoch'=recovery.predecessor_writer_epoch::text
      AND NEW.document::jsonb->'scope'->>'workspaceId'=recovery.workspace_id::text
      AND NEW.document::jsonb->'scope'->>'organizationId'=recovery.org_id::text) THEN
    RAISE EXCEPTION 'checkpoint history requires exact owner discard and current target' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_checkpoint_history_snapshot_identity BEFORE INSERT OR UPDATE OR DELETE ON cloud_agent_checkpoint_history_snapshots
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_checkpoint_history_snapshot();
-- zeros-expand-exception: truncate-guard Retain immutable history authorization across retries
CREATE TRIGGER cloud_checkpoint_history_snapshot_no_truncate BEFORE TRUNCATE ON cloud_agent_checkpoint_history_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION preserve_cloud_checkpoint_history_snapshot();
ALTER TABLE cloud_agent_checkpoint_history_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_agent_checkpoint_history_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_agent_checkpoint_history_snapshots USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,DELETE ON cloud_agent_checkpoint_history_snapshots TO zeros_app;
-- zeros-expand-exception: new-table-privileges Remove default mutable privileges from immutable history snapshots
REVOKE UPDATE,TRUNCATE ON cloud_agent_checkpoint_history_snapshots FROM PUBLIC,zeros_app;
-- zeros-expand-exception: privilege-tightening New private history helpers are only callable in a system transaction
REVOKE ALL ON FUNCTION cloud_owner_discard_history_receipt(uuid),preserve_cloud_checkpoint_history_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_owner_discard_history_receipt(uuid) TO zeros_app;
-- zeros-expand-exception: privilege-tightening New private retry helpers stay in system or operator transactions
REVOKE ALL ON FUNCTION cloud_owner_recovery_retry_ready(uuid,uuid,uuid,uuid),preserve_cloud_owner_recovery_retry(),
  require_cloud_owner_recovery_retry_transition(),cloud_owner_discard_transition_receipt(uuid,uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_owner_recovery_retry_ready(uuid,uuid,uuid,uuid),cloud_owner_discard_transition_receipt(uuid,uuid,uuid,integer) TO zeros_app;
