-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Explicit total loss is an operator disposition, never a saved checkpoint.
-- The receipt authorizes one normal Delete. Provider absence, metering and
-- physical object/record erasure remain the existing workers' responsibility.
CREATE TABLE cloud_workspace_owner_delete_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation>0),
  stop_intent_id uuid NOT NULL UNIQUE,
  request_id uuid NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL,
  operator_user_id uuid NOT NULL,
  owner_acknowledged_complete_loss boolean NOT NULL CHECK (owner_acknowledged_complete_loss),
  owner_approval_reference text NOT NULL CHECK (length(owner_approval_reference) BETWEEN 16 AND 512),
  reason text NOT NULL CHECK (length(reason) BETWEEN 16 AND 512),
  source jsonb NOT NULL CHECK (jsonb_typeof(source)='object' AND octet_length(source::text)<=1048576),
  source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256)=32),
  delete_key text NOT NULL CHECK (delete_key='owner-discard-delete.'||id::text),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256)=32),
  plan_sha256 bytea NOT NULL CHECK (octet_length(plan_sha256)=32),
  target_fingerprint text NOT NULL CHECK (target_fingerprint ~ '^[a-f0-9]{64}$'),
  database_principal text NOT NULL,
  admission_txid bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(org_id,delete_key),
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE
);
CREATE TABLE cloud_workspace_owner_delete_dispositions (
  lifecycle_intent_id uuid PRIMARY KEY,
  receipt_id uuid NOT NULL REFERENCES cloud_workspace_owner_delete_receipts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation>0),
  operation text NOT NULL CHECK (operation IN ('stop','archive','delete')),
  intent_sha256 bytea NOT NULL CHECK (octet_length(intent_sha256)=32),
  source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256)=32),
  original_state text NOT NULL CHECK (original_state IN ('capturing','retrying','reconciling','blocked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE
);
CREATE INDEX cloud_owner_delete_disposition_scope ON cloud_workspace_owner_delete_dispositions(receipt_id,workspace_id,org_id);
ALTER TABLE cloud_workspace_owner_delete_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_owner_delete_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_owner_delete_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_owner_delete_dispositions FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_workspace_owner_delete_receipts USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_only ON cloud_workspace_owner_delete_dispositions USING(app_is_system()) WITH CHECK(app_is_system());
-- zeros-expand-exception: new-table-privileges Only the database owner can record explicit complete-data-loss authority
REVOKE ALL ON cloud_workspace_owner_delete_receipts,cloud_workspace_owner_delete_dispositions FROM PUBLIC,zeros_app;
GRANT SELECT ON cloud_workspace_owner_delete_receipts,cloud_workspace_owner_delete_dispositions TO zeros_app;

-- Exact, bounded facts for plan/execute. A delivered capture, unsealed writer,
-- old successful checkpoint or crashed ready engine is retained, not treated
-- as absence of user work. Retry clocks are deliberately not approval inputs.
CREATE FUNCTION cloud_owner_delete_source(target_stop_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT jsonb_build_object(
    'organizationId',w.org_id,'workspaceId',w.id,'ownerUserId',w.owner_user_id,'generation',w.current_generation,
    'authorityEpoch',w.authority_epoch,'fundingOwnerEpoch',w.agent_funding_owner_epoch,'agentBootId',w.agent_boot_id,
    'stopIntentId',i.id,'requestId',q.id,'engineInstanceId',e.id,'allocationLeaseId',l.id,
    'providerResourceId',b.provider_resource_id,'providerAccountScope',p.account_scope,
    'providerConnectionId',g.provider_connection_id,'providerConnectionVersion',g.provider_connection_version,
    'runtimeId',g.runtime_id,'recoverySha256',encode(cloud_owner_discard_recovery_digest(i.id),'hex'),
    'contentHead',(SELECT to_jsonb(h)-'updated_at' FROM workspace_content_heads h WHERE h.workspace_id=w.id AND h.org_id=w.org_id),
    'recordHead',(SELECT to_jsonb(h)-'updated_at' FROM workspace_record_heads h WHERE h.workspace_id=w.id AND h.org_id=w.org_id),
    'history',coalesce((SELECT jsonb_agg(jsonb_build_object('id',h.id,'generation',h.generation,'operation',h.operation,
      'requestSha256',encode(h.request_sha256,'hex'),'idempotencyKey',h.idempotency_key,'requestedBy',h.requested_by,
      'state',h.state,'attemptCount',h.attempt_count,'dispatchedAt',h.dispatched_at,'affectsWorkspace',h.affects_workspace,
      'recovery',(SELECT to_jsonb(r)-ARRAY['retry_count','next_attempt_at','last_failure','last_checked_at','updated_at']
        FROM cloud_workspace_final_save_recoveries r WHERE r.lifecycle_intent_id=h.id)) ORDER BY h.created_at,h.id)
      FROM cloud_workspace_lifecycle_intents h WHERE h.workspace_id=w.id AND h.org_id=w.org_id AND h.operation IN ('stop','archive','delete')),'[]'::jsonb),
    'captures',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at,c.id) FROM workspace_checkpoint_requests c
      WHERE c.workspace_id=w.id AND c.org_id=w.org_id),'[]'::jsonb),
    'engines',coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.id,'generation',x.generation,'registeredAt',x.registered_at,
      'tokenSha256',encode(x.heartbeat_token_hash,'hex'),'runtimeId',x.runtime_id,'runtimeBootId',x.runtime_boot_id,
      'state',x.state,'revokedAt',x.revoked_at,'leaseExpiresAt',x.lease_expires_at,'finalCheckpointAt',x.final_checkpoint_at,
      'localCommandsVersion',x.cloud_local_commands_version,'finalSaveVersion',x.final_save_version) ORDER BY x.enrollment_order)
      FROM cloud_workspace_engine_instances x WHERE x.workspace_id=w.id AND x.org_id=w.org_id),'[]'::jsonb),
    'generations',(SELECT jsonb_agg(jsonb_build_object('generation',x.generation,'runtimeId',x.runtime_id,
      'provider',x.provider,'providerConnectionId',x.provider_connection_id,'providerConnectionVersion',x.provider_connection_version,
      'resourceId',y.provider_resource_id,'deletionVerifiedAt',y.deletion_verified_at) ORDER BY x.generation)
      FROM cloud_workspace_generations x LEFT JOIN cloud_workspace_provider_bindings y USING(workspace_id,generation,org_id)
      WHERE x.workspace_id=w.id AND x.org_id=w.org_id))
  FROM cloud_workspace_lifecycle_intents i
  JOIN cloud_workspaces w ON w.id=i.workspace_id AND w.org_id=i.org_id
  JOIN organizations o ON o.id=w.org_id AND NOT o.is_personal
  JOIN cloud_workspace_final_save_recoveries r ON r.lifecycle_intent_id=i.id AND r.workspace_id=w.id AND r.org_id=w.org_id
    AND r.generation=w.current_generation
  JOIN workspace_checkpoint_requests q ON q.id=r.current_request_id AND q.final_save_recovery_id=i.id
    AND q.workspace_id=w.id AND q.org_id=w.org_id AND q.generation=w.current_generation
  JOIN cloud_workspace_engine_instances e ON e.id=r.engine_instance_id AND e.workspace_id=w.id AND e.org_id=w.org_id
    AND e.generation=w.current_generation AND e.registered_at=r.registered_at AND e.heartbeat_token_hash=r.registration_token_sha256
    AND e.runtime_id IS NOT DISTINCT FROM r.runtime_id
  JOIN cloud_workspace_generations g ON g.workspace_id=w.id AND g.org_id=w.org_id AND g.generation=w.current_generation
  JOIN cloud_workspace_provider_bindings b ON b.workspace_id=w.id AND b.org_id=w.org_id AND b.generation=w.current_generation
  JOIN managed_compute_allocation_leases l ON l.id=r.allocation_lease_id AND l.workspace_id=w.id AND l.org_id=w.org_id
    AND l.generation=w.current_generation AND l.provider_resource_id=b.provider_resource_id
  JOIN cloud_workspace_provider_operations p ON p.workspace_id=w.id AND p.org_id=w.org_id AND p.generation=w.current_generation
    AND p.provider=b.provider AND p.resource_id=b.provider_resource_id
  WHERE i.id=target_stop_id AND i.generation=w.current_generation AND i.operation='stop' AND i.requested_by IS NULL
    AND i.state IN ('queued','observing') AND i.attempt_count=0 AND i.dispatched_at IS NULL AND i.lease_owner IS NULL
    AND i.generation_transition_id IS NULL AND i.resume_after_intent_id IS NULL
    AND i.idempotency_key LIKE 'system:compute-stop:%' AND l.stop_intent_id=i.id
    AND w.status IN ('stopping','stopped','failed','archived') AND w.desired_state IN ('stopped','archived')
    AND w.deleted_at IS NULL AND w.data_deleted_at IS NULL
    AND r.state IN ('capturing','retrying','reconciling','blocked') AND r.checkpoint_id IS NULL AND r.proven_request_id IS NULL
    AND q.state IN ('expired','failed','cancelled') AND q.completed_at IS NOT NULL AND isfinite(q.completed_at)
    AND q.final_save_attempt_ordinal=r.attempt_ordinal
    AND b.provider='boat' AND b.provider_resource_id=r.provider_resource_id AND b.deletion_verified_at IS NULL
    AND l.id=(SELECT latest.id FROM managed_compute_allocation_leases latest
      WHERE latest.workspace_id=w.id AND latest.org_id=w.org_id AND latest.provider_resource_id=b.provider_resource_id
      ORDER BY latest.created_at DESC,latest.id LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_allocation_owners a WHERE a.workspace_id=w.id AND a.org_id=w.org_id
      AND a.provider_resource_id=b.provider_resource_id AND (a.current_generation<>w.current_generation OR a.allocation_lease_id<>l.id))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_engine_instances live WHERE live.workspace_id=w.id AND live.org_id=w.org_id
      AND live.revoked_at IS NULL AND live.state IN ('starting','ready') AND live.lease_expires_at>clock_timestamp())
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_setup_runs live WHERE live.workspace_id=w.id AND live.org_id=w.org_id AND live.state IN ('queued','running'))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_runtime_transitions live WHERE live.workspace_id=w.id AND live.org_id=w.org_id
      AND live.phase NOT IN ('healthy','rolled_back','cancelled'))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_generation_transitions live WHERE live.workspace_id=w.id AND live.org_id=w.org_id
      AND live.state NOT IN ('succeeded','rolled_back','cancelled','rollback_failed'))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents live WHERE live.workspace_id=w.id AND live.org_id=w.org_id
      AND live.id<>i.id AND live.state IN ('queued','observing','dispatching'))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches d WHERE d.workspace_id=w.id AND d.org_id=w.org_id AND d.settled_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM workspace_checkpoint_requests c WHERE c.workspace_id=w.id AND c.org_id=w.org_id
      AND c.state NOT IN ('succeeded','expired','failed','cancelled'))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_generations x LEFT JOIN cloud_workspace_provider_bindings y USING(workspace_id,generation,org_id)
      WHERE x.workspace_id=w.id AND x.org_id=w.org_id AND x.generation<>w.current_generation
        AND (y.deletion_verified_at IS NULL OR NOT isfinite(y.deletion_verified_at)))
    AND NOT EXISTS (SELECT 1 FROM workspace_retention_policies h WHERE h.workspace_id=w.id AND h.org_id=w.org_id AND h.legal_hold)
    AND NOT EXISTS (SELECT 1 FROM workspace_checkpoints h WHERE h.workspace_id=w.id AND h.org_id=w.org_id AND h.legal_hold)
    AND NOT EXISTS (SELECT 1 FROM workspace_blob_references h JOIN workspace_blobs blob ON blob.id=h.blob_id AND blob.org_id=h.org_id
      WHERE h.workspace_id=w.id AND h.org_id=w.org_id AND blob.legal_hold)
    AND (SELECT count(*) FROM cloud_workspace_lifecycle_intents h WHERE h.workspace_id=w.id AND h.org_id=w.org_id AND h.operation IN ('stop','archive','delete'))<=256
    AND (SELECT count(*) FROM workspace_checkpoint_requests c WHERE c.workspace_id=w.id AND c.org_id=w.org_id)<=512
    AND (SELECT count(*) FROM cloud_workspace_engine_instances c WHERE c.workspace_id=w.id AND c.org_id=w.org_id)<=128
    AND (SELECT count(*) FROM cloud_workspace_generations c WHERE c.workspace_id=w.id AND c.org_id=w.org_id)<=64
$$;

CREATE FUNCTION guard_cloud_owner_delete_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE observed jsonb;
BEGIN
  -- Final organization erasure removes the owning workspace after its real
  -- provider/data gates. Ordinary data purge keeps that parent and receipt.
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM cloud_workspaces WHERE id=OLD.workspace_id AND org_id=OLD.org_id) THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'owner delete receipts are immutable' USING ERRCODE='55000'; END IF;
  IF current_user='zeros_app' OR NEW.database_principal<>current_user OR NEW.admission_txid<>txid_current()
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.cloud_workspace_owner_delete_receipts'::regclass
      AND pg_get_userbyid(relowner)=current_user) THEN
    RAISE EXCEPTION 'owner delete requires the migration owner' USING ERRCODE='42501';
  END IF;
  PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE;
  observed=cloud_owner_delete_source(NEW.stop_intent_id);
  IF observed IS NULL OR observed IS DISTINCT FROM NEW.source
    OR NEW.source_sha256 IS DISTINCT FROM digest(convert_to(observed::text,'UTF8'),'sha256')
    OR observed->>'organizationId'<>NEW.org_id::text OR observed->>'workspaceId'<>NEW.workspace_id::text
    OR observed->>'ownerUserId'<>NEW.owner_user_id::text OR observed->>'generation'<>NEW.generation::text
    OR observed->>'requestId'<>NEW.request_id::text
    OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.operator_user_id AND auth_status='active' AND deleted_at IS NULL AND staff_role='platform_owner') THEN
    RAISE EXCEPTION 'owner delete source changed' USING ERRCODE='40001';
  END IF;
  NEW.created_at=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_owner_delete_receipt_identity BEFORE INSERT OR UPDATE OR DELETE ON cloud_workspace_owner_delete_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_cloud_owner_delete_receipt();
-- zeros-expand-exception: truncate-guard Retain the complete-loss acknowledgement independently of physical data erasure
CREATE TRIGGER cloud_owner_delete_receipt_no_truncate BEFORE TRUNCATE ON cloud_workspace_owner_delete_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION guard_cloud_owner_delete_receipt();

CREATE FUNCTION guard_cloud_owner_delete_disposition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM cloud_workspaces WHERE id=OLD.workspace_id AND org_id=OLD.org_id) THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'owner delete dispositions are immutable' USING ERRCODE='55000'; END IF;
  IF current_user='zeros_app' OR NOT EXISTS (SELECT 1 FROM cloud_workspace_owner_delete_receipts receipt
    JOIN cloud_workspace_lifecycle_intents intent ON intent.id=NEW.lifecycle_intent_id AND intent.workspace_id=receipt.workspace_id AND intent.org_id=receipt.org_id
    JOIN cloud_workspace_final_save_recoveries recovery ON recovery.lifecycle_intent_id=intent.id
    WHERE receipt.id=NEW.receipt_id AND receipt.admission_txid=txid_current() AND receipt.database_principal=current_user
      AND NEW.workspace_id=receipt.workspace_id AND NEW.org_id=receipt.org_id AND NEW.generation=intent.generation
      AND NEW.operation=intent.operation::text AND NEW.intent_sha256=intent.request_sha256
      AND NEW.source_sha256=cloud_owner_discard_recovery_digest(intent.id) AND NEW.original_state=recovery.state
      AND (EXISTS (SELECT 1 FROM jsonb_array_elements(receipt.source->'history') item
        WHERE item->>'id'=intent.id::text AND item->>'requestSha256'=encode(intent.request_sha256,'hex')
          AND item->>'generation'=intent.generation::text AND item->>'operation'=intent.operation::text
          AND (item->'recovery'='null'::jsonb OR item->'recovery'=(to_jsonb(recovery)
            -ARRAY['retry_count','next_attempt_at','last_failure','last_checked_at','updated_at'])))
        OR (intent.operation='delete' AND intent.generation=receipt.generation AND intent.requested_by=receipt.owner_user_id
          AND intent.idempotency_key=receipt.delete_key AND intent.request_sha256=receipt.request_sha256
          AND intent.affects_workspace AND intent.state='queued' AND intent.attempt_count=0 AND intent.dispatched_at IS NULL))
      AND NOT EXISTS (SELECT 1 FROM workspace_checkpoint_requests request WHERE request.final_save_recovery_id=intent.id
        AND request.state NOT IN ('succeeded','expired','failed','cancelled'))) THEN
    RAISE EXCEPTION 'owner delete disposition is outside the approved inventory' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_owner_delete_disposition_identity BEFORE INSERT OR UPDATE OR DELETE ON cloud_workspace_owner_delete_dispositions
  FOR EACH ROW EXECUTE FUNCTION guard_cloud_owner_delete_disposition();
-- zeros-expand-exception: truncate-guard Keep exact historical loss dispositions after request erasure
CREATE TRIGGER cloud_owner_delete_disposition_no_truncate BEFORE TRUNCATE ON cloud_workspace_owner_delete_dispositions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_cloud_owner_delete_disposition();

-- zeros-expand-exception: owner-delete-disposition Preserve 0173 restore dispositions and add only the new exact immutable inventory
CREATE OR REPLACE FUNCTION cloud_final_save_owner_discarded(target_intent_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM cloud_workspace_owner_discard_receipts WHERE stop_intent_id=target_intent_id OR safety_stop_intent_id=target_intent_id)
    OR EXISTS (SELECT 1 FROM cloud_workspace_owner_delete_dispositions WHERE lifecycle_intent_id=target_intent_id)
$$;

-- The normal dispatch guard and post-I/O recheck use this separate authority.
-- It does not satisfy cloud_final_save_proven or any Restart/restore prerequisite.
CREATE FUNCTION cloud_owner_delete_current(target_intent_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM cloud_workspace_owner_delete_receipts receipt
    JOIN cloud_workspace_owner_delete_dispositions disposition ON disposition.receipt_id=receipt.id AND disposition.lifecycle_intent_id=target_intent_id
    JOIN cloud_workspace_lifecycle_intents intent ON intent.id=disposition.lifecycle_intent_id AND intent.workspace_id=receipt.workspace_id AND intent.org_id=receipt.org_id
    JOIN cloud_workspaces w ON w.id=receipt.workspace_id AND w.org_id=receipt.org_id
    JOIN cloud_workspace_final_save_recoveries r ON r.lifecycle_intent_id=intent.id
    JOIN cloud_workspace_provider_bindings b ON b.workspace_id=w.id AND b.org_id=w.org_id AND b.generation=receipt.generation
    JOIN cloud_workspace_generations g ON g.workspace_id=w.id AND g.org_id=w.org_id AND g.generation=receipt.generation
    JOIN cloud_workspace_provider_operations p ON p.workspace_id=w.id AND p.org_id=w.org_id AND p.generation=receipt.generation
    WHERE intent.id=target_intent_id AND intent.operation='delete' AND intent.affects_workspace
      AND intent.requested_by=receipt.owner_user_id AND intent.idempotency_key=receipt.delete_key AND intent.request_sha256=receipt.request_sha256
      AND intent.generation=receipt.generation AND intent.generation_transition_id IS NULL AND intent.resume_after_intent_id IS NULL
      AND w.current_generation=receipt.generation AND w.owner_user_id=receipt.owner_user_id
      AND w.accepted_lifecycle_intent_id=intent.id AND w.desired_state='deleted' AND w.status IN ('deleting','deleted')
      AND r.state='discarded' AND r.checkpoint_id IS NULL AND r.proven_request_id IS NULL
      AND r.generation=receipt.generation AND r.workspace_id=w.id AND r.org_id=w.org_id
      AND disposition.intent_sha256=intent.request_sha256 AND disposition.source_sha256=digest(convert_to(jsonb_build_array(
        r.lifecycle_intent_id,r.workspace_id,r.org_id,r.generation,r.operation,r.original_request_id,r.current_request_id,r.attempt_ordinal,
        r.engine_instance_id,extract(epoch from r.registered_at),r.registration_token_sha256,r.runtime_id,r.boot_id,r.writer_epoch,
        r.funding_owner_user_id,r.funding_owner_epoch,r.authority_epoch,r.allocation_lease_id,r.provider_resource_id,r.custody_id)::text,'UTF8'),'sha256')
      AND b.provider='boat' AND b.provider_resource_id=receipt.source->>'providerResourceId' AND r.provider_resource_id=b.provider_resource_id
      AND p.provider=b.provider AND p.resource_id=b.provider_resource_id AND p.account_scope=receipt.source->>'providerAccountScope'
      AND g.provider_connection_id::text=receipt.source->>'providerConnectionId'
      AND g.provider_connection_version::text=receipt.source->>'providerConnectionVersion'
      AND g.runtime_id IS NOT DISTINCT FROM receipt.source->>'runtimeId'
      AND r.engine_instance_id::text=receipt.source->>'engineInstanceId'
      AND r.allocation_lease_id::text=receipt.source->>'allocationLeaseId'
      AND r.allocation_lease_id=(SELECT latest.id FROM managed_compute_allocation_leases latest WHERE latest.workspace_id=w.id
        AND latest.org_id=w.org_id AND latest.provider_resource_id=b.provider_resource_id ORDER BY latest.created_at DESC,latest.id LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_allocation_owners a WHERE a.workspace_id=w.id AND a.org_id=w.org_id
        AND a.provider_resource_id=b.provider_resource_id AND (a.current_generation<>w.current_generation OR a.allocation_lease_id<>r.allocation_lease_id))
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_engine_instances e WHERE e.workspace_id=w.id AND e.org_id=w.org_id
        AND e.revoked_at IS NULL AND e.state IN ('starting','ready'))
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_setup_runs s WHERE s.workspace_id=w.id AND s.org_id=w.org_id AND s.state IN ('queued','running'))
      AND NOT EXISTS (SELECT 1 FROM workspace_retention_policies h WHERE h.workspace_id=w.id AND h.org_id=w.org_id AND h.legal_hold)
      AND NOT EXISTS (SELECT 1 FROM workspace_checkpoints h WHERE h.workspace_id=w.id AND h.org_id=w.org_id AND h.legal_hold)
      AND NOT EXISTS (SELECT 1 FROM workspace_blob_references h JOIN workspace_blobs blob ON blob.id=h.blob_id AND blob.org_id=h.org_id
        WHERE h.workspace_id=w.id AND h.org_id=w.org_id AND blob.legal_hold))
$$;

-- zeros-expand-exception: owner-delete-dispatch Keep both existing dispatch authorities and add the single approved Delete only
CREATE OR REPLACE FUNCTION cloud_final_save_dispatchable(target_intent_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT cloud_final_save_proven(target_intent_id) OR cloud_unstarted_candidate_current(target_intent_id) OR cloud_owner_delete_current(target_intent_id)
$$;

-- Keep captured histories terminal and the Delete's real provider failures.
-- Runs after the legacy final-save guards; it never converts a failure to success.
CREATE FUNCTION cloud_owner_delete_hold_intent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt cloud_workspace_owner_delete_receipts;
BEGIN
  -- Updates must serialize before checking for the first, possibly still
  -- uncommitted receipt. Its approved history includes these mutable facts.
  PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE NOWAIT;
  SELECT * INTO receipt FROM cloud_workspace_owner_delete_receipts WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    IF receipt.admission_txid<>txid_current() OR current_user<>receipt.database_principal
      OR NEW.operation<>'delete' OR NEW.generation<>receipt.generation OR NEW.requested_by IS DISTINCT FROM receipt.owner_user_id
      OR NEW.idempotency_key<>receipt.delete_key OR NEW.request_sha256<>receipt.request_sha256 OR NOT NEW.affects_workspace
      OR NEW.state<>'queued' OR NEW.attempt_count<>0 OR NEW.dispatched_at IS NOT NULL
      OR NEW.generation_transition_id IS NOT NULL OR NEW.resume_after_intent_id IS NOT NULL THEN
      RAISE EXCEPTION 'owner delete permits one exact Delete' USING ERRCODE='40001';
    END IF;
  ELSE
    IF ROW(NEW.id,NEW.workspace_id,NEW.org_id,NEW.generation,NEW.operation,NEW.idempotency_key,NEW.request_sha256,NEW.requested_by,
        NEW.generation_transition_id,NEW.resume_after_intent_id)
      IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.org_id,OLD.generation,OLD.operation,OLD.idempotency_key,OLD.request_sha256,OLD.requested_by,
        OLD.generation_transition_id,OLD.resume_after_intent_id) THEN
      RAISE EXCEPTION 'owner delete lifecycle identity is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.id=receipt.stop_intent_id THEN
      NEW.state='superseded'; NEW.completed_at=receipt.created_at; NEW.affects_workspace=false;
      NEW.lease_owner=NULL; NEW.lease_expires_at=NULL; NEW.error_code='owner_discarded';
      NEW.error_message='Owner acknowledged complete data loss and requested deletion';
    ELSIF OLD.idempotency_key=receipt.delete_key AND OLD.state IN ('failed','succeeded','superseded')
      AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'owner delete terminal result is immutable' USING ERRCODE='40001';
    ELSIF NEW.idempotency_key<>receipt.delete_key AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'owner delete history is retained' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zzzz_cloud_owner_delete_hold_intent BEFORE INSERT OR UPDATE ON cloud_workspace_lifecycle_intents
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_intent();

-- zeros-expand-exception: owner-delete-failure Preserve unsaved ordinary operations while allowing truthful failure of the exact approved Delete
CREATE OR REPLACE FUNCTION cloud_final_save_preserve_lifecycle() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.state IN ('failed','superseded') AND OLD.operation IN ('stop','archive','delete') THEN
    PERFORM ensure_cloud_final_save_recovery(OLD.id);
  END IF;
  IF NEW.state IN ('failed','superseded') AND OLD.state IN ('queued','observing','dispatching')
    AND EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=OLD.id AND state<>'resolved')
    AND NOT cloud_final_save_proven(OLD.id) AND NOT cloud_owner_delete_current(OLD.id) THEN
    NEW.state=CASE WHEN OLD.state='dispatching' THEN 'observing'::cloud_workspace_intent_state ELSE OLD.state END;
    NEW.completed_at=NULL; NEW.error_code=OLD.error_code; NEW.error_message=OLD.error_message;
    NEW.lease_owner=NULL; NEW.lease_expires_at=NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION require_cloud_owner_delete_atomic() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents deletion
    JOIN cloud_workspace_lifecycle_intents stop ON stop.id=NEW.stop_intent_id
    JOIN workspace_deletion_jobs job ON job.workspace_id=NEW.workspace_id AND job.org_id=NEW.org_id
    WHERE deletion.workspace_id=NEW.workspace_id AND deletion.org_id=NEW.org_id AND deletion.idempotency_key=NEW.delete_key
      AND cloud_owner_delete_current(deletion.id) AND deletion.state='queued' AND job.idempotency_key='lifecycle.'||deletion.id::text
      AND job.state='waiting_for_provider' AND stop.state='superseded' AND NOT stop.affects_workspace AND stop.error_code='owner_discarded')
    OR EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries r WHERE r.workspace_id=NEW.workspace_id AND r.org_id=NEW.org_id
      AND r.state NOT IN ('proven','resolved','discarded','not_required'))
    OR NOT EXISTS (SELECT 1 FROM cloud_workspace_owner_delete_dispositions d JOIN cloud_workspace_final_save_recoveries r
      ON r.lifecycle_intent_id=d.lifecycle_intent_id WHERE d.receipt_id=NEW.id AND d.lifecycle_intent_id=NEW.stop_intent_id
      AND r.state='discarded' AND r.next_attempt_at='infinity'::timestamptz) THEN
    RAISE EXCEPTION 'owner discard and exact normal Delete must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cloud_owner_delete_atomic AFTER INSERT ON cloud_workspace_owner_delete_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cloud_owner_delete_atomic();

-- Mutation paths serialize with receipt admission BEFORE checking its existence.
-- NOWAIT avoids the reverse lease->workspace lock order; a rejected worker must
-- release its claim and retry. Retirement/settlement and provider observations
-- remain possible. No registration, renewal, generation or new writer can revive.
CREATE FUNCTION cloud_owner_delete_hold_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scope_id uuid; scope_org uuid; changed boolean; retirement boolean=false;
BEGIN
  IF TG_TABLE_NAME='cloud_workspaces' THEN
    scope_id=NEW.id; scope_org=NEW.org_id;
    changed=ROW(NEW.current_generation,NEW.owner_user_id) IS DISTINCT FROM ROW(OLD.current_generation,OLD.owner_user_id)
      OR (NEW.agent_boot_id IS NOT NULL AND NEW.agent_boot_id IS DISTINCT FROM OLD.agent_boot_id)
      OR (NEW.desired_state<>'deleted' AND NEW.desired_state IS DISTINCT FROM OLD.desired_state);
  ELSE
    scope_id=NEW.workspace_id; scope_org=NEW.org_id; changed=TG_OP='INSERT';
    IF TG_OP='UPDATE' THEN
      IF TG_TABLE_NAME='cloud_workspace_engine_instances' THEN
        changed=ROW(NEW.workspace_id,NEW.org_id,NEW.generation,NEW.registered_at,NEW.heartbeat_token_hash,NEW.runtime_id,NEW.runtime_boot_id)
          IS DISTINCT FROM ROW(OLD.workspace_id,OLD.org_id,OLD.generation,OLD.registered_at,OLD.heartbeat_token_hash,OLD.runtime_id,OLD.runtime_boot_id)
          OR (NEW.revoked_at IS NULL AND (NEW.state IN ('starting','ready')) AND
            ROW(NEW.state,NEW.revoked_at,NEW.lease_expires_at,NEW.last_heartbeat_at) IS DISTINCT FROM ROW(OLD.state,OLD.revoked_at,OLD.lease_expires_at,OLD.last_heartbeat_at));
      ELSIF TG_TABLE_NAME='cloud_workspace_setup_runs' THEN
        changed=NEW.state IN ('queued','running','succeeded') AND NEW IS DISTINCT FROM OLD;
      ELSIF TG_TABLE_NAME='cloud_workspace_provider_bindings' THEN
        changed=ROW(NEW.workspace_id,NEW.org_id,NEW.generation,NEW.provider,NEW.provider_resource_id,NEW.provider_target)
          IS DISTINCT FROM ROW(OLD.workspace_id,OLD.org_id,OLD.generation,OLD.provider,OLD.provider_resource_id,OLD.provider_target);
      ELSIF TG_TABLE_NAME='cloud_workspace_provider_operations' THEN
        changed=ROW(NEW.workspace_id,NEW.org_id,NEW.generation,NEW.provider,NEW.account_scope,NEW.resource_id)
          IS DISTINCT FROM ROW(OLD.workspace_id,OLD.org_id,OLD.generation,OLD.provider,OLD.account_scope,OLD.resource_id);
      ELSIF TG_TABLE_NAME='managed_compute_allocation_leases' THEN
        changed=ROW(NEW.workspace_id,NEW.org_id,NEW.generation,NEW.provider_resource_id,NEW.funded_until,NEW.provider_expires_at)
          IS DISTINCT FROM ROW(OLD.workspace_id,OLD.org_id,OLD.generation,OLD.provider_resource_id,OLD.funded_until,OLD.provider_expires_at)
          OR (NEW.state IN ('funding','authorized','active') AND NEW.state IS DISTINCT FROM OLD.state);
      ELSIF TG_TABLE_NAME='cloud_workspace_generations' THEN
        changed=(to_jsonb(NEW)-ARRAY['retired_at','recovery_checkpoint_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['retired_at','recovery_checkpoint_id'])
          OR (NEW.recovery_checkpoint_id IS NOT NULL AND NEW.recovery_checkpoint_id IS DISTINCT FROM OLD.recovery_checkpoint_id);
      ELSIF TG_TABLE_NAME IN ('cloud_workspace_endpoint_grants','cloud_workspace_runtime_service_grants') THEN
        changed=NEW.revoked_at IS NULL AND NEW IS DISTINCT FROM OLD;
      ELSIF TG_TABLE_NAME='cloud_workspace_client_access_grants' THEN
        changed=NEW.state IN ('issuing','active') AND NEW IS DISTINCT FROM OLD;
      ELSIF TG_TABLE_NAME='cloud_agent_boot_bindings' THEN
        changed=NEW IS DISTINCT FROM OLD;
        retirement=OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL AND isfinite(NEW.retired_at)
          AND (to_jsonb(NEW)-'retired_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'retired_at');
      ELSIF TG_TABLE_NAME='cloud_workspace_local_command_writers' THEN
        changed=NEW IS DISTINCT FROM OLD;
        retirement=OLD.state='active' AND NEW.state='retired' AND OLD.retired_at IS NULL
          AND NEW.retired_at IS NOT NULL AND isfinite(NEW.retired_at)
          AND (to_jsonb(NEW)-ARRAY['state','retired_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','retired_at']);
      ELSE changed=NEW IS DISTINCT FROM OLD; END IF;
    END IF;
  END IF;
  IF NOT changed THEN RETURN NEW; END IF;
  PERFORM id FROM cloud_workspaces WHERE id=scope_id AND org_id=scope_org FOR UPDATE NOWAIT;
  IF EXISTS (SELECT 1 FROM cloud_workspace_owner_delete_receipts WHERE workspace_id=scope_id AND org_id=scope_org) THEN
    -- The ordinary reconciler retires boot sources after its positive Delete
    -- observation. This changes source liveness only: every seal/ACK and all
    -- captured identity remain byte-identical, including an unsealed writer.
    IF retirement THEN
      IF EXISTS (SELECT 1 FROM cloud_workspace_owner_delete_receipts receipt
      JOIN cloud_workspace_lifecycle_intents deletion ON deletion.workspace_id=receipt.workspace_id AND deletion.org_id=receipt.org_id
        AND deletion.idempotency_key=receipt.delete_key
      JOIN cloud_workspace_final_save_dispatches dispatch ON dispatch.lifecycle_intent_id=deletion.id
      JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=receipt.workspace_id AND binding.org_id=receipt.org_id
        AND binding.generation=receipt.generation AND binding.provider_resource_id=dispatch.provider_resource_id
      WHERE receipt.workspace_id=scope_id AND receipt.org_id=scope_org AND receipt.generation=NEW.generation
        AND cloud_owner_delete_current(deletion.id) AND deletion.state='succeeded'
        AND dispatch.settled_at>=dispatch.admitted_at AND binding.deletion_verified_at>=dispatch.admitted_at
        AND NEW.retired_at>=receipt.created_at) THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'owner discard Delete holds this source' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_owner_delete_hold_workspace BEFORE UPDATE OF current_generation,owner_user_id,agent_boot_id,desired_state ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_source();
CREATE TRIGGER cloud_owner_delete_hold_engine BEFORE INSERT OR UPDATE ON cloud_workspace_engine_instances
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_source();
CREATE TRIGGER cloud_owner_delete_hold_setup BEFORE INSERT OR UPDATE ON cloud_workspace_setup_runs
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_source();
CREATE TRIGGER cloud_owner_delete_hold_boot BEFORE INSERT OR UPDATE ON cloud_agent_boot_bindings
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_source();
CREATE TRIGGER cloud_owner_delete_hold_writer BEFORE INSERT OR UPDATE ON cloud_workspace_local_command_writers
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_source();
CREATE TRIGGER cloud_owner_delete_hold_generation BEFORE INSERT OR UPDATE ON cloud_workspace_generations
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_source();
CREATE TRIGGER cloud_owner_delete_hold_transition BEFORE INSERT OR UPDATE ON cloud_workspace_generation_transitions
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_source();
CREATE TRIGGER cloud_owner_delete_hold_runtime BEFORE INSERT OR UPDATE ON cloud_workspace_runtime_transitions
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_source();
CREATE TRIGGER cloud_owner_delete_hold_binding BEFORE INSERT OR UPDATE ON cloud_workspace_provider_bindings
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_source();
CREATE TRIGGER cloud_owner_delete_hold_provider_operation BEFORE INSERT OR UPDATE ON cloud_workspace_provider_operations
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_source();
CREATE TRIGGER cloud_owner_delete_hold_lease BEFORE INSERT OR UPDATE ON managed_compute_allocation_leases
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_source();
CREATE TRIGGER cloud_owner_delete_hold_allocation BEFORE INSERT OR UPDATE ON cloud_workspace_allocation_owners
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_source();
CREATE TRIGGER cloud_owner_delete_hold_endpoint BEFORE INSERT OR UPDATE ON cloud_workspace_endpoint_grants
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_source();
CREATE TRIGGER cloud_owner_delete_hold_service_grant BEFORE INSERT OR UPDATE ON cloud_workspace_runtime_service_grants
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_source();
CREATE TRIGGER cloud_owner_delete_hold_client_grant BEFORE INSERT OR UPDATE ON cloud_workspace_client_access_grants
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_source();

-- Recovery identity can legitimately fill a missing custody value before
-- disposition. Serialize those facts with the first receipt, while leaving
-- excluded retry clocks alone. Existing recovery guards retain their authority
-- and freeze the committed disposition; this trigger grants no new admission.
CREATE FUNCTION cloud_owner_delete_lock_recovery_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['retry_count','next_attempt_at','last_failure','last_checked_at','updated_at'])
    IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['retry_count','next_attempt_at','last_failure','last_checked_at','updated_at']) THEN RETURN NEW; END IF;
  PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE NOWAIT;
  RETURN NEW;
END $$;
CREATE TRIGGER a_cloud_owner_delete_lock_recovery_source BEFORE INSERT OR UPDATE ON cloud_workspace_final_save_recoveries
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_lock_recovery_source();

CREATE FUNCTION cloud_owner_delete_hold_capture_facts() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt cloud_workspace_owner_delete_receipts;
BEGIN
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE NOWAIT;
  SELECT * INTO receipt FROM cloud_workspace_owner_delete_receipts WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  -- Lazy legacy adoption may add its reciprocal link in this same admission;
  -- it may not change the retained attempt, state, reports or native retirement.
  IF TG_OP='UPDATE' AND receipt.admission_txid=txid_current() AND receipt.database_principal=current_user
    AND (to_jsonb(NEW)-ARRAY['final_save_recovery_id','final_save_attempt_ordinal'])
      IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['final_save_recovery_id','final_save_attempt_ordinal']) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'owner delete capture facts are retained' USING ERRCODE='40001';
END $$;
CREATE TRIGGER zzzz_cloud_owner_delete_hold_capture_facts BEFORE INSERT OR UPDATE ON workspace_checkpoint_requests
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_capture_facts();

-- A cancelled/revoked network request cannot append after loss admission.
-- The real erasure worker may still clear checkpoint head references, and a
-- later legal hold can always protect data before the worker deletes it.
CREATE FUNCTION cloud_owner_delete_hold_data() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE NOWAIT;
  IF NOT EXISTS (SELECT 1 FROM cloud_workspace_owner_delete_receipts WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id) THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='workspace_checkpoints'
    AND (to_jsonb(NEW)-ARRAY['legal_hold','retention_until']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['legal_hold','retention_until']) THEN RETURN NEW; END IF;
  IF cloud_workspace_data_purge_authorized(NEW.workspace_id,NEW.org_id) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'owner delete data source is closed' USING ERRCODE='40001';
END $$;
CREATE TRIGGER cloud_owner_delete_hold_content_head BEFORE INSERT OR UPDATE ON workspace_content_heads
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_data();
CREATE TRIGGER cloud_owner_delete_hold_record_head BEFORE INSERT OR UPDATE ON workspace_record_heads
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_data();
CREATE TRIGGER cloud_owner_delete_hold_content BEFORE INSERT OR UPDATE ON workspace_content_revisions
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_data();
CREATE TRIGGER cloud_owner_delete_hold_records BEFORE INSERT OR UPDATE ON workspace_record_batches
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_data();
CREATE TRIGGER cloud_owner_delete_hold_record_events BEFORE INSERT OR UPDATE ON workspace_record_events
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_data();
CREATE TRIGGER cloud_owner_delete_hold_checkpoint BEFORE INSERT OR UPDATE ON workspace_checkpoints
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_delete_hold_data();

-- zeros-expand-exception: privilege-tightening Operator plan and mutation guards are not application admission APIs
REVOKE ALL ON FUNCTION cloud_owner_delete_source(uuid),guard_cloud_owner_delete_receipt(),guard_cloud_owner_delete_disposition(),
  cloud_owner_delete_current(uuid),cloud_owner_delete_hold_intent(),require_cloud_owner_delete_atomic(),cloud_owner_delete_hold_source(),
  cloud_owner_delete_lock_recovery_source(),cloud_owner_delete_hold_capture_facts(),cloud_owner_delete_hold_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_owner_delete_current(uuid) TO zeros_app;

-- zeros-expand-exception: owner-delete-erasure Require the exact completed Delete for owner-discard current-generation erasure
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
            AND recovery.generation=workspace.current_generation AND recovery.state IN ('proven','resolved'))
        AND NOT EXISTS (SELECT 1 FROM cloud_workspace_owner_delete_receipts receipt
          JOIN cloud_workspace_lifecycle_intents deletion ON deletion.workspace_id=receipt.workspace_id AND deletion.org_id=receipt.org_id
            AND deletion.idempotency_key=receipt.delete_key
          JOIN cloud_workspace_final_save_dispatches dispatch ON dispatch.lifecycle_intent_id=deletion.id
          JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=receipt.workspace_id AND binding.org_id=receipt.org_id
            AND binding.generation=receipt.generation AND binding.provider_resource_id=dispatch.provider_resource_id
          JOIN workspace_deletion_jobs job ON job.workspace_id=receipt.workspace_id AND job.org_id=receipt.org_id AND job.idempotency_key='lifecycle.'||deletion.id::text
          WHERE receipt.workspace_id=workspace.id AND receipt.org_id=workspace.org_id AND receipt.generation=workspace.current_generation
            AND cloud_owner_delete_current(deletion.id) AND deletion.state='succeeded'
            AND dispatch.settled_at>=dispatch.admitted_at AND binding.deletion_verified_at>=dispatch.admitted_at))
$$;
