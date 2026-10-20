-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A loss acknowledgement is not final-save proof. Only the database owner
-- can append this exact disposition; 0171's proof and dispatch gates remain.
CREATE TABLE cloud_workspace_owner_discard_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  source_generation integer NOT NULL CHECK (source_generation>0),
  stop_intent_id uuid NOT NULL UNIQUE,
  wake_intent_id uuid NOT NULL UNIQUE CHECK (wake_intent_id<>stop_intent_id),
  request_id uuid NOT NULL,
  retirement_id uuid NOT NULL,
  custody_id uuid NOT NULL,
  source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256)=32),
  provider_loss_attestation_id uuid NOT NULL,
  provider_resource_id text NOT NULL CHECK (length(provider_resource_id) BETWEEN 1 AND 256),
  checkpoint_id uuid NOT NULL,
  checkpoint_sha256 bytea NOT NULL CHECK (octet_length(checkpoint_sha256)=32),
  checkpoint_content_revision bigint NOT NULL CHECK (checkpoint_content_revision>0),
  checkpoint_record_revision bigint NOT NULL CHECK (checkpoint_record_revision>=0),
  checkpoint_at timestamptz NOT NULL,
  computer_build_id uuid NOT NULL,
  computer_config_id uuid NOT NULL,
  runtime_id text NOT NULL CHECK (runtime_id ~ '^r1-[a-f0-9]{64}$'),
  owner_user_id uuid NOT NULL,
  operator_user_id uuid NOT NULL,
  owner_approval_reference text NOT NULL CHECK (length(owner_approval_reference) BETWEEN 16 AND 512),
  reason text NOT NULL CHECK (length(reason) BETWEEN 16 AND 512),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256)=32),
  plan_sha256 bytea NOT NULL CHECK (octet_length(plan_sha256)=32),
  target_fingerprint text NOT NULL CHECK (target_fingerprint ~ '^[a-f0-9]{64}$'),
  database_principal text NOT NULL CHECK (length(database_principal) BETWEEN 1 AND 128),
  transition_id uuid NOT NULL UNIQUE,
  candidate_generation integer NOT NULL CHECK (candidate_generation>source_generation),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id,source_generation,org_id),
  FOREIGN KEY (workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE
);
ALTER TABLE cloud_workspace_owner_discard_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_owner_discard_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_workspace_owner_discard_receipts USING (app_is_system()) WITH CHECK (app_is_system());
-- zeros-expand-exception: new-table-privileges Remove 0004 default application writes from the new owner-only receipt
REVOKE ALL ON cloud_workspace_owner_discard_receipts FROM PUBLIC,zeros_app;
GRANT SELECT ON cloud_workspace_owner_discard_receipts TO zeros_app;

-- Truthful terminal disposition for N-1 health and retry readers. This is
-- never saved proof: the original proof-equivalence constraint is unchanged.
-- zeros-expand-exception: widen-check Retain every state and add only the exact receipt-backed discard
ALTER TABLE cloud_workspace_final_save_recoveries DROP CONSTRAINT cloud_workspace_final_save_recoveries_state_check;
ALTER TABLE cloud_workspace_final_save_recoveries ADD CONSTRAINT cloud_workspace_final_save_recoveries_state_check
  CHECK (state IN ('capturing','retrying','reconciling','blocked','proven','resolved','discarded'));

CREATE FUNCTION cloud_final_save_owner_discarded(target_intent_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM cloud_workspace_owner_discard_receipts WHERE stop_intent_id=target_intent_id)
$$;

CREATE FUNCTION guard_cloud_owner_discard_receipt() RETURNS trigger
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
      AND wake.state IN ('queued','observing') AND wake.attempt_count=0 AND wake.dispatched_at IS NULL AND wake.lease_owner IS NULL
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
      AND loss.lookup_observed_at BETWEEN clock_timestamp()-interval '15 minutes' AND clock_timestamp()
      AND loss.inventory_observed_at BETWEEN clock_timestamp()-interval '15 minutes' AND clock_timestamp()
      AND cloud_provider_allocation_lost(workspace.id,NEW.source_generation,workspace.org_id,NEW.provider_resource_id)
  ) OR EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches
    WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id AND settled_at IS NULL)
    OR EXISTS (SELECT 1 FROM cloud_workspace_engine_instances WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id
      AND generation=NEW.source_generation AND state IN ('starting','ready') AND revoked_at IS NULL AND lease_expires_at>clock_timestamp())
  THEN RAISE EXCEPTION 'owner discard target or custody changed' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_owner_discard_append_only BEFORE INSERT OR UPDATE OR DELETE ON cloud_workspace_owner_discard_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_cloud_owner_discard_receipt();
-- zeros-expand-exception: truncate-guard The new receipt rejects TRUNCATE; this trigger never performs one
CREATE TRIGGER cloud_owner_discard_no_truncate BEFORE TRUNCATE ON cloud_workspace_owner_discard_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION guard_cloud_owner_discard_receipt();

-- Atomic receipt + exact candidate. No committed receipt can grant a later
-- unrelated restore, change the chosen Computer, or relabel the Stop saved.
CREATE FUNCTION require_cloud_owner_discard_transition() RETURNS trigger
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
      AND recovery.checkpoint_id IS NULL AND recovery.proven_request_id IS NULL) THEN
    RAISE EXCEPTION 'owner discard requires its exact recovery transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER cloud_owner_discard_transition AFTER INSERT ON cloud_workspace_owner_discard_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cloud_owner_discard_transition();

-- Runs after 0162/0171 preservation. The two named intents are retired, never
-- successful. Other intents keep every existing mandatory/final-save guard.
CREATE FUNCTION cloud_owner_discard_retire_intent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt cloud_workspace_owner_discard_receipts;
BEGIN
  SELECT * INTO receipt FROM cloud_workspace_owner_discard_receipts
    WHERE workspace_id=OLD.workspace_id AND org_id=OLD.org_id AND source_generation=OLD.generation
      AND (stop_intent_id=OLD.id OR wake_intent_id=OLD.id);
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
CREATE TRIGGER zzz_cloud_owner_discard_retire_intent BEFORE UPDATE ON cloud_workspace_lifecycle_intents
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_discard_retire_intent();

-- Retain the original failure, journal identity and custody byte-for-byte.
-- Only state and its no-retry timestamp change, atomically with the receipt.
-- Stale workers may re-read them, but cannot create another capture attempt.
CREATE FUNCTION cloud_owner_discard_hold_capture() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='cloud_workspace_final_save_recoveries' THEN
    IF NEW.state='discarded' AND (TG_OP='INSERT' OR NOT cloud_final_save_owner_discarded(NEW.lifecycle_intent_id)) THEN
      RAISE EXCEPTION 'discarded recovery requires its owner receipt' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND cloud_final_save_owner_discarded(OLD.lifecycle_intent_id) THEN
      NEW=OLD;
      NEW.state='discarded'; NEW.next_attempt_at='infinity'::timestamptz;
      RETURN NEW;
    END IF;
  ELSIF cloud_final_save_owner_discarded(NEW.final_save_recovery_id) THEN
    IF TG_OP='INSERT' THEN RAISE EXCEPTION 'owner discarded capture is retired' USING ERRCODE='40001'; END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_cloud_owner_discard_hold_recovery BEFORE INSERT OR UPDATE ON cloud_workspace_final_save_recoveries
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_discard_hold_capture();
CREATE TRIGGER zz_cloud_owner_discard_hold_attempt BEFORE INSERT OR UPDATE ON workspace_checkpoint_requests
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_discard_hold_capture();

-- Compatibility for a worker finishing this exact recovery: the source is
-- positively attested lost, so its redundant system cleanup has no I/O to do.
-- This does not admit a destructive dispatch or retire any candidate work.
CREATE FUNCTION cloud_owner_discard_skip_lost_cleanup() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.operation IN ('stop','delete') AND NEW.requested_by IS NULL AND NOT NEW.affects_workspace
    AND EXISTS (SELECT 1 FROM cloud_workspace_owner_discard_receipts receipt
      WHERE receipt.workspace_id=NEW.workspace_id AND receipt.org_id=NEW.org_id AND receipt.source_generation=NEW.generation
        AND receipt.transition_id=NEW.generation_transition_id
        AND cloud_provider_allocation_lost(NEW.workspace_id,NEW.generation,NEW.org_id,receipt.provider_resource_id)) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_owner_discard_skip_lost_cleanup BEFORE INSERT ON cloud_workspace_lifecycle_intents
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_discard_skip_lost_cleanup();

-- zeros-expand-exception: privilege-tightening New operator-only receipt guards are not public APIs
REVOKE ALL ON FUNCTION guard_cloud_owner_discard_receipt(),require_cloud_owner_discard_transition(),cloud_owner_discard_retire_intent(),
  cloud_owner_discard_hold_capture(),cloud_owner_discard_skip_lost_cleanup(),cloud_final_save_owner_discarded(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_final_save_owner_discarded(uuid) TO zeros_app;

-- Only the explicitly discarded historical save is exempt from the unresolved
-- history set. Current-generation final proof, provider retirement, job custody,
-- legal holds and physical object/record erasure checks are unchanged.
-- zeros-expand-exception: owner-discard-history Ignore only the exact owner-discarded historical recovery; every other gate remains
CREATE OR REPLACE FUNCTION cloud_final_save_deletion_claimable(target_workspace_id uuid,target_org_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries
      WHERE workspace_id=target_workspace_id AND org_id=target_org_id AND state NOT IN ('proven','resolved')
        AND NOT cloud_final_save_owner_discarded(lifecycle_intent_id))
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

-- zeros-expand-exception: owner-discard-purge Retain job custody and physical erasure gates while honoring the exact historical discard
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
          AND NOT cloud_final_save_owner_discarded(recovery.lifecycle_intent_id))
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
