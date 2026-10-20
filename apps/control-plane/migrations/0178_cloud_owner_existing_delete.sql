-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A cancelled capture can have been delivered. This classifies only an
-- abandoned provider Stop, never successful capture or native retirement.
-- Already enrolled recovery remains an obligation until explicit disposition.
CREATE FUNCTION cloud_final_save_retired_compute_stop(target_intent_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents i
    JOIN workspace_checkpoint_requests q ON q.lifecycle_intent_id=i.id AND q.workspace_id=i.workspace_id
      AND q.org_id=i.org_id AND q.generation=i.generation
    WHERE i.id=target_intent_id AND i.operation='stop' AND i.requested_by IS NULL
      AND i.idempotency_key LIKE 'system:compute-stop:%' AND i.state='superseded' AND i.error_code='workspace_active'
      AND i.attempt_count=0 AND i.dispatched_at IS NULL AND i.lease_owner IS NULL AND i.lease_expires_at IS NULL
      AND i.completed_at IS NOT NULL AND isfinite(i.completed_at)
      AND i.generation_transition_id IS NULL AND i.resume_after_intent_id IS NULL
      AND q.reason='before_stop' AND q.idempotency_key='compute.'||i.id::text AND q.state='cancelled'
      AND q.error_code='workspace_active' AND q.checkpoint_id IS NULL
      AND q.completed_at IS NOT NULL AND isfinite(q.completed_at)
      AND NOT cloud_workspace_drain_is_mandatory(i.id)
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches d WHERE d.lifecycle_intent_id=i.id)
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_generation_transitions t WHERE t.drain_intent_id=i.id)
      AND NOT EXISTS (SELECT 1 FROM workspace_checkpoint_requests other WHERE other.lifecycle_intent_id=i.id AND other.id<>q.id))
$$;

-- Old idle Stops without captures were intentionally never enrolled. They
-- remain a history gap unless the exact terminal row was included in a full
-- loss approval and that receipt's normal Delete has positively completed.
-- This is erasure authority only; no recovery or final-save proof is created.
CREATE FUNCTION cloud_owner_delete_captured_idle_history(target_intent_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents i
    JOIN cloud_workspace_owner_delete_receipts receipt ON receipt.workspace_id=i.workspace_id AND receipt.org_id=i.org_id
    JOIN cloud_workspace_lifecycle_intents deletion ON deletion.workspace_id=receipt.workspace_id AND deletion.org_id=receipt.org_id
      AND deletion.idempotency_key=receipt.delete_key
    JOIN cloud_workspaces w ON w.id=receipt.workspace_id AND w.org_id=receipt.org_id
    JOIN cloud_workspace_final_save_dispatches dispatch ON dispatch.lifecycle_intent_id=deletion.id
      AND dispatch.workspace_id=w.id AND dispatch.org_id=w.org_id AND dispatch.generation=receipt.generation
    JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=w.id AND binding.org_id=w.org_id
      AND binding.generation=receipt.generation AND binding.provider_resource_id=dispatch.provider_resource_id
    JOIN workspace_deletion_jobs job ON job.workspace_id=w.id AND job.org_id=w.org_id
      AND job.idempotency_key='lifecycle.'||deletion.id::text
    WHERE i.id=target_intent_id AND i.operation='stop' AND i.requested_by IS NULL AND i.idempotency_key LIKE 'system:idle:%'
      AND i.state='succeeded' AND i.attempt_count>0 AND i.dispatched_at IS NOT NULL AND isfinite(i.dispatched_at)
      AND i.completed_at IS NOT NULL AND isfinite(i.completed_at) AND i.completed_at<=receipt.created_at
      AND i.generation_transition_id IS NULL AND i.resume_after_intent_id IS NULL
      AND NOT cloud_workspace_drain_is_mandatory(i.id)
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_generation_transitions t WHERE t.drain_intent_id=i.id)
      AND NOT EXISTS (SELECT 1 FROM workspace_checkpoint_requests q WHERE q.lifecycle_intent_id=i.id OR q.final_save_recovery_id=i.id)
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries r WHERE r.lifecycle_intent_id=i.id)
      AND receipt.owner_acknowledged_complete_loss AND receipt.generation=w.current_generation
      AND w.accepted_lifecycle_intent_id=deletion.id AND w.status='deleted' AND w.desired_state='deleted'
      AND cloud_owner_delete_current(deletion.id) AND deletion.state='succeeded'
      AND dispatch.settled_at>=dispatch.admitted_at AND isfinite(dispatch.settled_at)
      AND binding.deletion_verified_at>=dispatch.admitted_at AND isfinite(binding.deletion_verified_at)
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(receipt.source->'history') captured
        WHERE captured=jsonb_build_object('id',i.id,'generation',i.generation,'operation',i.operation,
          'requestSha256',encode(i.request_sha256,'hex'),'idempotencyKey',i.idempotency_key,'requestedBy',i.requested_by,
          'state',i.state,'attemptCount',i.attempt_count,'dispatchedAt',i.dispatched_at,'affectsWorkspace',i.affects_workspace,
          'recovery',NULL)))
$$;

-- A new receipt has no authority over the old 0177 Stop-to-new-Delete path.
-- One already accepted Delete and one unresolved recovery are named exactly.
CREATE TABLE cloud_workspace_owner_existing_delete_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation>0),
  delete_intent_id uuid NOT NULL UNIQUE,
  recovery_intent_id uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('pending_delete','retired_history')),
  owner_user_id uuid NOT NULL,
  operator_user_id uuid NOT NULL,
  owner_acknowledged_complete_loss boolean NOT NULL CHECK (owner_acknowledged_complete_loss),
  owner_approval_reference text NOT NULL CHECK (length(owner_approval_reference) BETWEEN 16 AND 512),
  reason text NOT NULL CHECK (length(reason) BETWEEN 16 AND 512),
  source jsonb NOT NULL CHECK (jsonb_typeof(source)='object' AND octet_length(source::text)<=1048576),
  source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256)=32),
  recovery_sha256 bytea NOT NULL CHECK (octet_length(recovery_sha256)=32),
  delete_key text NOT NULL,
  delete_sha256 bytea NOT NULL CHECK (octet_length(delete_sha256)=32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256)=32),
  plan_sha256 bytea NOT NULL CHECK (octet_length(plan_sha256)=32),
  target_fingerprint text NOT NULL CHECK (target_fingerprint ~ '^[a-f0-9]{64}$'),
  database_principal text NOT NULL,
  admission_txid bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE
);
ALTER TABLE cloud_workspace_owner_existing_delete_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_owner_existing_delete_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_workspace_owner_existing_delete_receipts USING(app_is_system()) WITH CHECK(app_is_system());
-- zeros-expand-exception: new-table-privileges Explicit existing-Delete loss is restricted to the database owner
REVOKE ALL ON cloud_workspace_owner_existing_delete_receipts FROM PUBLIC,zeros_app;
GRANT SELECT ON cloud_workspace_owner_existing_delete_receipts TO zeros_app;

CREATE FUNCTION cloud_owner_existing_delete_source(target_delete_id uuid,target_recovery_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT jsonb_build_object(
    'kind',CASE WHEN d.id=i.id THEN 'pending_delete' ELSE 'retired_history' END,
    'organizationId',w.org_id,'workspaceId',w.id,'ownerUserId',w.owner_user_id,'generation',w.current_generation,
    'authorityEpoch',w.authority_epoch,'fundingOwnerEpoch',w.agent_funding_owner_epoch,'agentBootId',w.agent_boot_id,
    'deleteIntentId',d.id,'recoveryIntentId',i.id,'engineInstanceId',r.engine_instance_id,'allocationLeaseId',r.allocation_lease_id,
    'providerResourceId',b.provider_resource_id,'providerAccountScope',p.account_scope,
    'providerConnectionId',g.provider_connection_id,'providerConnectionVersion',g.provider_connection_version,'runtimeId',g.runtime_id,
    'deleteKey',d.idempotency_key,'deleteSha256',encode(d.request_sha256,'hex'),
    'recoverySha256',encode(cloud_owner_discard_recovery_digest(i.id),'hex'),
    'recovery',to_jsonb(r)-ARRAY['retry_count','next_attempt_at','last_failure','last_checked_at','updated_at'],
    'history',coalesce((SELECT jsonb_agg(to_jsonb(h)-ARRAY['next_attempt_at','updated_at'] ORDER BY h.created_at,h.id)
      FROM cloud_workspace_lifecycle_intents h WHERE h.workspace_id=w.id AND h.org_id=w.org_id),'[]'::jsonb),
    'captures',coalesce((SELECT jsonb_agg(to_jsonb(q) ORDER BY q.created_at,q.id) FROM workspace_checkpoint_requests q
      WHERE q.workspace_id=w.id AND q.org_id=w.org_id),'[]'::jsonb),
    'contentHead',(SELECT to_jsonb(h)-'updated_at' FROM workspace_content_heads h WHERE h.workspace_id=w.id AND h.org_id=w.org_id),
    'recordHead',(SELECT to_jsonb(h)-'updated_at' FROM workspace_record_heads h WHERE h.workspace_id=w.id AND h.org_id=w.org_id),
    'engines',(SELECT jsonb_agg(jsonb_build_object('id',e.id,'generation',e.generation,'registeredAt',e.registered_at,
      'tokenSha256',encode(e.heartbeat_token_hash,'hex'),'runtimeId',e.runtime_id,'runtimeBootId',e.runtime_boot_id,
      'state',e.state,'revokedAt',e.revoked_at,'leaseExpiresAt',e.lease_expires_at) ORDER BY e.enrollment_order)
      FROM cloud_workspace_engine_instances e WHERE e.workspace_id=w.id AND e.org_id=w.org_id),
    'writers',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.writer_epoch) FROM cloud_workspace_local_command_writers x
      WHERE x.workspace_id=w.id AND x.org_id=w.org_id),'[]'::jsonb),
    'boots',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM cloud_agent_boot_bindings x
      WHERE x.workspace_id=w.id AND x.org_id=w.org_id),'[]'::jsonb),
    'generations',(SELECT jsonb_agg(jsonb_build_object('generation',x.generation,'runtimeId',x.runtime_id,
      'provider',x.provider,'providerConnectionId',x.provider_connection_id,'providerConnectionVersion',x.provider_connection_version,
      'resourceId',y.provider_resource_id,'deletionVerifiedAt',y.deletion_verified_at) ORDER BY x.generation)
      FROM cloud_workspace_generations x LEFT JOIN cloud_workspace_provider_bindings y USING(workspace_id,generation,org_id)
      WHERE x.workspace_id=w.id AND x.org_id=w.org_id),
    'dispatch',(SELECT to_jsonb(x) FROM cloud_workspace_final_save_dispatches x WHERE x.lifecycle_intent_id=d.id))
  FROM cloud_workspace_lifecycle_intents d
  JOIN cloud_workspaces w ON w.id=d.workspace_id AND w.org_id=d.org_id
  JOIN organizations o ON o.id=w.org_id AND NOT o.is_personal
  JOIN cloud_workspace_lifecycle_intents i ON i.id=target_recovery_id AND i.workspace_id=w.id AND i.org_id=w.org_id
  JOIN cloud_workspace_final_save_recoveries r ON r.lifecycle_intent_id=i.id AND r.workspace_id=w.id AND r.org_id=w.org_id
    AND r.generation=i.generation AND r.operation=i.operation::text
  JOIN cloud_workspace_engine_instances e ON e.id=r.engine_instance_id AND e.workspace_id=w.id AND e.org_id=w.org_id
    AND e.generation=r.generation AND e.registered_at=r.registered_at AND e.heartbeat_token_hash=r.registration_token_sha256
    AND e.runtime_id IS NOT DISTINCT FROM r.runtime_id
  JOIN cloud_workspace_generations g ON g.workspace_id=w.id AND g.org_id=w.org_id AND g.generation=w.current_generation
  JOIN cloud_workspace_provider_bindings b ON b.workspace_id=w.id AND b.org_id=w.org_id AND b.generation=g.generation
  JOIN managed_compute_allocation_leases l ON l.id=r.allocation_lease_id AND l.workspace_id=w.id AND l.org_id=w.org_id
    AND l.generation=r.generation AND l.provider_resource_id=r.provider_resource_id
  JOIN cloud_workspace_provider_operations p ON p.workspace_id=w.id AND p.org_id=w.org_id AND p.generation=g.generation
    AND p.provider=b.provider AND p.resource_id=b.provider_resource_id
  JOIN workspace_deletion_jobs job ON job.workspace_id=w.id AND job.org_id=w.org_id AND job.idempotency_key='lifecycle.'||d.id::text
  WHERE d.id=target_delete_id AND d.operation='delete' AND d.affects_workspace AND d.requested_by=w.owner_user_id
    AND d.generation=w.current_generation AND d.generation_transition_id IS NULL AND d.resume_after_intent_id IS NULL
    AND w.accepted_lifecycle_intent_id=d.id AND w.data_deleted_at IS NULL
    AND r.state IN ('capturing','retrying','reconciling','blocked') AND r.checkpoint_id IS NULL AND r.proven_request_id IS NULL
    AND r.generation=w.current_generation AND r.provider_resource_id=b.provider_resource_id AND b.provider='boat'
    AND job.state='waiting_for_provider' AND job.lease_owner IS NULL
    AND ((d.id=i.id AND d.state='queued' AND d.attempt_count=0 AND d.dispatched_at IS NULL AND d.lease_owner IS NULL
        AND d.lease_expires_at IS NULL AND d.completed_at IS NULL AND r.original_request_id IS NULL AND r.current_request_id IS NULL
        AND r.attempt_ordinal=0 AND r.custody_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM workspace_checkpoint_requests q WHERE q.lifecycle_intent_id=d.id OR q.final_save_recovery_id=d.id)
        AND w.status IN ('stopped','failed','archived') AND w.desired_state IN ('stopped','archived') AND w.deleted_at IS NULL
        AND b.deletion_verified_at IS NULL
        AND l.id=(SELECT latest.id FROM managed_compute_allocation_leases latest WHERE latest.workspace_id=w.id AND latest.org_id=w.org_id
          AND latest.provider_resource_id=b.provider_resource_id ORDER BY latest.created_at DESC,latest.id LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM cloud_workspace_allocation_owners a WHERE a.workspace_id=w.id AND a.org_id=w.org_id
          AND a.provider_resource_id=b.provider_resource_id AND (a.current_generation<>w.current_generation OR a.allocation_lease_id<>l.id)))
      OR (d.id<>i.id AND cloud_final_save_retired_compute_stop(i.id) AND d.state='succeeded'
        AND d.completed_at IS NOT NULL AND isfinite(d.completed_at) AND d.created_at>=i.completed_at
        AND cloud_final_save_proven(d.id) AND w.status='deleted' AND w.desired_state='deleted'
        AND w.deleted_at IS NOT NULL AND isfinite(w.deleted_at)
        AND EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches dispatch
          JOIN cloud_workspace_final_save_recoveries saved ON saved.lifecycle_intent_id=d.id
          WHERE dispatch.lifecycle_intent_id=d.id AND dispatch.workspace_id=w.id AND dispatch.org_id=w.org_id
            AND dispatch.generation=w.current_generation AND dispatch.provider_resource_id=b.provider_resource_id
            AND ROW(dispatch.engine_instance_id,dispatch.boot_id,dispatch.allocation_lease_id)
              IS NOT DISTINCT FROM ROW(saved.engine_instance_id,saved.boot_id,saved.allocation_lease_id)
            AND dispatch.settled_at>=dispatch.admitted_at AND isfinite(dispatch.settled_at)
            AND b.deletion_verified_at>=dispatch.admitted_at AND isfinite(b.deletion_verified_at))))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_engine_instances live WHERE live.workspace_id=w.id AND live.org_id=w.org_id
      AND live.revoked_at IS NULL AND live.state IN ('starting','ready') AND live.lease_expires_at>clock_timestamp())
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_setup_runs live WHERE live.workspace_id=w.id AND live.org_id=w.org_id AND live.state IN ('queued','running'))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_runtime_transitions live WHERE live.workspace_id=w.id AND live.org_id=w.org_id
      AND live.phase NOT IN ('healthy','rolled_back','cancelled'))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_generation_transitions live WHERE live.workspace_id=w.id AND live.org_id=w.org_id
      AND live.state NOT IN ('succeeded','rolled_back','cancelled','rollback_failed'))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents live WHERE live.workspace_id=w.id AND live.org_id=w.org_id
      AND live.id<>d.id AND live.state IN ('queued','observing','dispatching'))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches held WHERE held.workspace_id=w.id AND held.org_id=w.org_id AND held.settled_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM workspace_checkpoint_requests q WHERE q.workspace_id=w.id AND q.org_id=w.org_id
      AND q.state NOT IN ('succeeded','expired','failed','cancelled'))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries other WHERE other.workspace_id=w.id AND other.org_id=w.org_id
      AND other.lifecycle_intent_id<>i.id AND other.state NOT IN ('proven','resolved')
      AND NOT cloud_final_save_owner_discarded(other.lifecycle_intent_id)
      AND NOT cloud_unstarted_candidate_current(other.lifecycle_intent_id))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_generations x LEFT JOIN cloud_workspace_provider_bindings y USING(workspace_id,generation,org_id)
      WHERE x.workspace_id=w.id AND x.org_id=w.org_id AND x.generation<>w.current_generation
        AND (y.deletion_verified_at IS NULL OR NOT isfinite(y.deletion_verified_at)))
    AND NOT EXISTS (SELECT 1 FROM workspace_retention_policies h WHERE h.workspace_id=w.id AND h.org_id=w.org_id AND h.legal_hold)
    AND NOT EXISTS (SELECT 1 FROM workspace_checkpoints h WHERE h.workspace_id=w.id AND h.org_id=w.org_id AND h.legal_hold)
    AND NOT EXISTS (SELECT 1 FROM workspace_blob_references h JOIN workspace_blobs blob ON blob.id=h.blob_id AND blob.org_id=h.org_id
      WHERE h.workspace_id=w.id AND h.org_id=w.org_id AND blob.legal_hold)
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_owner_delete_receipts old WHERE old.workspace_id=w.id AND old.org_id=w.org_id)
    AND (SELECT count(*) FROM cloud_workspace_lifecycle_intents h WHERE h.workspace_id=w.id AND h.org_id=w.org_id)<=512
    AND (SELECT count(*) FROM workspace_checkpoint_requests h WHERE h.workspace_id=w.id AND h.org_id=w.org_id)<=512
    AND (SELECT count(*) FROM cloud_workspace_engine_instances h WHERE h.workspace_id=w.id AND h.org_id=w.org_id)<=128
    AND (SELECT count(*) FROM cloud_workspace_generations h WHERE h.workspace_id=w.id AND h.org_id=w.org_id)<=64
$$;

CREATE FUNCTION guard_cloud_owner_existing_delete_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE observed jsonb;
BEGIN
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM cloud_workspaces WHERE id=OLD.workspace_id AND org_id=OLD.org_id) THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'existing Delete loss receipt is immutable' USING ERRCODE='55000'; END IF;
  IF current_user='zeros_app' OR NEW.database_principal<>current_user OR NEW.admission_txid<>txid_current()
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.cloud_workspace_owner_existing_delete_receipts'::regclass
      AND pg_get_userbyid(relowner)=current_user) THEN
    RAISE EXCEPTION 'existing Delete loss requires the migration owner' USING ERRCODE='42501';
  END IF;
  PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE;
  observed=cloud_owner_existing_delete_source(NEW.delete_intent_id,NEW.recovery_intent_id);
  IF observed IS NULL OR observed IS DISTINCT FROM NEW.source
    OR NEW.source_sha256 IS DISTINCT FROM digest(convert_to(observed::text,'UTF8'),'sha256')
    OR NEW.recovery_sha256 IS DISTINCT FROM cloud_owner_discard_recovery_digest(NEW.recovery_intent_id)
    OR observed->>'kind' IS DISTINCT FROM NEW.kind OR observed->>'organizationId' IS DISTINCT FROM NEW.org_id::text
    OR observed->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text OR observed->>'ownerUserId' IS DISTINCT FROM NEW.owner_user_id::text
    OR observed->>'generation' IS DISTINCT FROM NEW.generation::text OR observed->>'deleteKey' IS DISTINCT FROM NEW.delete_key
    OR observed->>'deleteSha256' IS DISTINCT FROM encode(NEW.delete_sha256,'hex')
    OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.operator_user_id AND auth_status='active' AND deleted_at IS NULL AND staff_role='platform_owner') THEN
    RAISE EXCEPTION 'existing Delete loss source changed' USING ERRCODE='40001';
  END IF;
  NEW.created_at=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_owner_existing_delete_receipt_identity BEFORE INSERT OR UPDATE OR DELETE ON cloud_workspace_owner_existing_delete_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_cloud_owner_existing_delete_receipt();
-- zeros-expand-exception: truncate-guard Keep the exact loss receipt after data erasure
CREATE TRIGGER cloud_owner_existing_delete_receipt_no_truncate BEFORE TRUNCATE ON cloud_workspace_owner_existing_delete_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION guard_cloud_owner_existing_delete_receipt();

CREATE FUNCTION cloud_owner_existing_delete_current(target_intent_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM cloud_workspace_owner_existing_delete_receipts receipt
    JOIN cloud_workspace_lifecycle_intents d ON d.id=receipt.delete_intent_id AND d.workspace_id=receipt.workspace_id AND d.org_id=receipt.org_id
    JOIN cloud_workspaces w ON w.id=receipt.workspace_id AND w.org_id=receipt.org_id
    JOIN cloud_workspace_final_save_recoveries r ON r.lifecycle_intent_id=receipt.recovery_intent_id
    JOIN cloud_workspace_generations g ON g.workspace_id=w.id AND g.org_id=w.org_id AND g.generation=receipt.generation
    JOIN cloud_workspace_provider_bindings b ON b.workspace_id=w.id AND b.org_id=w.org_id AND b.generation=receipt.generation
    JOIN cloud_workspace_provider_operations p ON p.workspace_id=w.id AND p.org_id=w.org_id AND p.generation=receipt.generation
    WHERE d.id=target_intent_id AND receipt.kind='pending_delete' AND receipt.recovery_intent_id=d.id
      AND d.operation='delete' AND d.generation=receipt.generation AND d.requested_by=receipt.owner_user_id AND d.affects_workspace
      AND d.idempotency_key=receipt.delete_key AND d.request_sha256=receipt.delete_sha256
      AND d.generation_transition_id IS NULL AND d.resume_after_intent_id IS NULL
      AND w.current_generation=receipt.generation AND w.owner_user_id=receipt.owner_user_id AND w.accepted_lifecycle_intent_id=d.id
      AND w.desired_state='deleted' AND w.status IN ('deleting','deleted')
      AND r.state='discarded' AND r.checkpoint_id IS NULL AND r.proven_request_id IS NULL
      AND r.workspace_id=w.id AND r.org_id=w.org_id AND r.generation=receipt.generation
      AND receipt.recovery_sha256=digest(convert_to(jsonb_build_array(
        r.lifecycle_intent_id,r.workspace_id,r.org_id,r.generation,r.operation,r.original_request_id,r.current_request_id,r.attempt_ordinal,
        r.engine_instance_id,extract(epoch from r.registered_at),r.registration_token_sha256,r.runtime_id,r.boot_id,r.writer_epoch,
        r.funding_owner_user_id,r.funding_owner_epoch,r.authority_epoch,r.allocation_lease_id,r.provider_resource_id,r.custody_id)::text,'UTF8'),'sha256')
      AND b.provider='boat' AND b.provider_resource_id=receipt.source->>'providerResourceId' AND r.provider_resource_id=b.provider_resource_id
      AND p.provider=b.provider AND p.resource_id=b.provider_resource_id AND p.account_scope=receipt.source->>'providerAccountScope'
      AND g.provider_connection_id::text=receipt.source->>'providerConnectionId'
      AND g.provider_connection_version::text=receipt.source->>'providerConnectionVersion'
      AND g.runtime_id IS NOT DISTINCT FROM receipt.source->>'runtimeId'
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

CREATE FUNCTION cloud_owner_existing_delete_completed(target_intent_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM cloud_workspace_owner_existing_delete_receipts receipt
    JOIN cloud_workspace_lifecycle_intents d ON d.id=receipt.delete_intent_id AND d.workspace_id=receipt.workspace_id AND d.org_id=receipt.org_id
    JOIN cloud_workspaces w ON w.id=receipt.workspace_id AND w.org_id=receipt.org_id
    JOIN cloud_workspace_final_save_dispatches dispatch ON dispatch.lifecycle_intent_id=d.id
    JOIN cloud_workspace_provider_bindings b ON b.workspace_id=w.id AND b.org_id=w.org_id AND b.generation=receipt.generation
    JOIN workspace_deletion_jobs job ON job.workspace_id=w.id AND job.org_id=w.org_id AND job.idempotency_key='lifecycle.'||d.id::text
    WHERE d.id=target_intent_id AND d.state='succeeded' AND d.operation='delete' AND d.request_sha256=receipt.delete_sha256
      AND d.idempotency_key=receipt.delete_key AND w.accepted_lifecycle_intent_id=d.id AND w.current_generation=receipt.generation
      AND w.owner_user_id=receipt.owner_user_id AND w.status='deleted' AND w.desired_state='deleted'
      AND dispatch.workspace_id=w.id AND dispatch.org_id=w.org_id AND dispatch.generation=receipt.generation
      AND dispatch.provider_resource_id=b.provider_resource_id AND b.provider_resource_id=receipt.source->>'providerResourceId'
      AND dispatch.settled_at>=dispatch.admitted_at AND isfinite(dispatch.settled_at)
      AND b.deletion_verified_at>=dispatch.admitted_at AND isfinite(b.deletion_verified_at)
      AND (cloud_owner_existing_delete_current(d.id) OR (receipt.kind='retired_history' AND cloud_final_save_proven(d.id))))
$$;

CREATE FUNCTION require_cloud_owner_existing_delete_atomic() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries r
    JOIN workspace_deletion_jobs job ON job.workspace_id=NEW.workspace_id AND job.org_id=NEW.org_id
      AND job.idempotency_key='lifecycle.'||NEW.delete_intent_id::text AND job.state='waiting_for_provider'
    WHERE r.lifecycle_intent_id=NEW.recovery_intent_id AND r.state='discarded' AND r.next_attempt_at='infinity'::timestamptz
      AND cloud_owner_discard_recovery_digest(r.lifecycle_intent_id)=NEW.recovery_sha256
      AND ((NEW.kind='pending_delete' AND cloud_owner_existing_delete_current(NEW.delete_intent_id))
        OR (NEW.kind='retired_history' AND cloud_owner_existing_delete_completed(NEW.delete_intent_id)))) THEN
    RAISE EXCEPTION 'existing Delete loss and exact disposition must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cloud_owner_existing_delete_atomic AFTER INSERT ON cloud_workspace_owner_existing_delete_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_cloud_owner_existing_delete_atomic();

CREATE FUNCTION cloud_owner_existing_delete_hold_intent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt cloud_workspace_owner_existing_delete_receipts;
BEGIN
  PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE NOWAIT;
  SELECT * INTO receipt FROM cloud_workspace_owner_existing_delete_receipts WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN RAISE EXCEPTION 'existing Delete loss permits no replacement intent' USING ERRCODE='40001'; END IF;
  IF ROW(NEW.id,NEW.workspace_id,NEW.org_id,NEW.generation,NEW.operation,NEW.idempotency_key,NEW.request_sha256,NEW.requested_by,
      NEW.generation_transition_id,NEW.resume_after_intent_id,NEW.affects_workspace)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.org_id,OLD.generation,OLD.operation,OLD.idempotency_key,OLD.request_sha256,OLD.requested_by,
      OLD.generation_transition_id,OLD.resume_after_intent_id,OLD.affects_workspace) THEN
    RAISE EXCEPTION 'existing Delete lifecycle identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW IS DISTINCT FROM OLD AND (OLD.id<>receipt.delete_intent_id OR OLD.state IN ('succeeded','failed','superseded')) THEN
    RAISE EXCEPTION 'existing Delete terminal history is retained' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zzzzz_cloud_owner_existing_delete_hold_intent BEFORE INSERT OR UPDATE ON cloud_workspace_lifecycle_intents
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_existing_delete_hold_intent();

CREATE FUNCTION cloud_owner_existing_delete_hold_projection() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.accepted_lifecycle_intent_id IS DISTINCT FROM OLD.accepted_lifecycle_intent_id
    AND EXISTS (SELECT 1 FROM cloud_workspace_owner_existing_delete_receipts WHERE workspace_id=OLD.id AND org_id=OLD.org_id) THEN
    RAISE EXCEPTION 'existing Delete acceptance is retained' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_owner_existing_delete_hold_projection BEFORE UPDATE OF accepted_lifecycle_intent_id ON cloud_workspaces
  FOR EACH ROW EXECUTE FUNCTION cloud_owner_existing_delete_hold_projection();

-- zeros-expand-exception: privilege-tightening Only the migration owner may inspect or record operator loss authority
REVOKE ALL ON FUNCTION cloud_final_save_retired_compute_stop(uuid),cloud_owner_delete_captured_idle_history(uuid),cloud_owner_existing_delete_source(uuid,uuid),
  guard_cloud_owner_existing_delete_receipt(),cloud_owner_existing_delete_current(uuid),cloud_owner_existing_delete_completed(uuid),
  require_cloud_owner_existing_delete_atomic(),cloud_owner_existing_delete_hold_intent(),cloud_owner_existing_delete_hold_projection() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_final_save_retired_compute_stop(uuid),cloud_owner_delete_captured_idle_history(uuid),cloud_owner_existing_delete_current(uuid),
  cloud_owner_existing_delete_completed(uuid) TO zeros_app;


-- zeros-expand-exception: retired-stop-enrollment Preserve previous authority and add only the exact existing-Delete loss branch
CREATE OR REPLACE FUNCTION ensure_cloud_final_save_recovery(target_intent_id uuid) RETURNS void
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
    AND NOT cloud_final_save_retired_compute_stop(intent.id)
  ON CONFLICT (lifecycle_intent_id) DO NOTHING;
END $$;


-- zeros-expand-exception: existing-delete-disposition Preserve previous authority and add only the exact existing-Delete loss branch
CREATE OR REPLACE FUNCTION cloud_final_save_owner_discarded(target_intent_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM cloud_workspace_owner_discard_receipts WHERE stop_intent_id=target_intent_id OR safety_stop_intent_id=target_intent_id)
    OR EXISTS (SELECT 1 FROM cloud_workspace_owner_delete_dispositions WHERE lifecycle_intent_id=target_intent_id)
    OR EXISTS (SELECT 1 FROM cloud_workspace_owner_existing_delete_receipts WHERE recovery_intent_id=target_intent_id)
$$;


-- zeros-expand-exception: existing-delete-dispatch Preserve previous authority and add only the exact existing-Delete loss branch
CREATE OR REPLACE FUNCTION cloud_final_save_dispatchable(target_intent_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT cloud_final_save_proven(target_intent_id) OR cloud_unstarted_candidate_current(target_intent_id) OR cloud_owner_delete_current(target_intent_id) OR cloud_owner_existing_delete_current(target_intent_id)
$$;


-- zeros-expand-exception: existing-delete-failure Preserve previous authority and add only the exact existing-Delete loss branch
CREATE OR REPLACE FUNCTION cloud_final_save_preserve_lifecycle() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.state IN ('failed','superseded') AND OLD.operation IN ('stop','archive','delete') THEN
    PERFORM ensure_cloud_final_save_recovery(OLD.id);
  END IF;
  IF NEW.state IN ('failed','superseded') AND OLD.state IN ('queued','observing','dispatching')
    AND EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=OLD.id AND state<>'resolved')
    AND NOT cloud_final_save_proven(OLD.id) AND NOT cloud_owner_delete_current(OLD.id) AND NOT cloud_owner_existing_delete_current(OLD.id) THEN
    NEW.state=CASE WHEN OLD.state='dispatching' THEN 'observing'::cloud_workspace_intent_state ELSE OLD.state END;
    NEW.completed_at=NULL; NEW.error_code=OLD.error_code; NEW.error_message=OLD.error_message;
    NEW.lease_owner=NULL; NEW.lease_expires_at=NULL;
  END IF;
  RETURN NEW;
END $$;


-- zeros-expand-exception: existing-delete-erasure Preserve previous authority and add only the exact existing-Delete loss branch
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
        AND NOT cloud_final_save_retired_compute_stop(intent.id)
        AND NOT cloud_owner_delete_captured_idle_history(intent.id)
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
            AND dispatch.settled_at>=dispatch.admitted_at AND binding.deletion_verified_at>=dispatch.admitted_at)
        AND NOT EXISTS (SELECT 1 FROM cloud_workspace_owner_existing_delete_receipts receipt
          WHERE receipt.workspace_id=workspace.id AND receipt.org_id=workspace.org_id AND receipt.generation=workspace.current_generation
            AND cloud_owner_existing_delete_completed(receipt.delete_intent_id)))
$$;


-- zeros-expand-exception: existing-delete-source-hold Preserve previous authority and add only the exact existing-Delete loss branch
CREATE OR REPLACE FUNCTION cloud_owner_delete_hold_source() RETURNS trigger
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
  IF EXISTS (SELECT 1 FROM cloud_workspace_owner_delete_receipts WHERE workspace_id=scope_id AND org_id=scope_org)
    OR EXISTS (SELECT 1 FROM cloud_workspace_owner_existing_delete_receipts WHERE workspace_id=scope_id AND org_id=scope_org) THEN
    -- The ordinary reconciler retires boot sources after its positive Delete
    -- observation. This changes source liveness only: every seal/ACK and all
    -- captured identity remain byte-identical, including an unsealed writer.
    IF retirement THEN
      IF EXISTS (SELECT 1 FROM cloud_workspace_owner_existing_delete_receipts receipt
        WHERE receipt.workspace_id=scope_id AND receipt.org_id=scope_org AND receipt.generation=NEW.generation
          AND NEW.retired_at>=receipt.created_at AND cloud_owner_existing_delete_completed(receipt.delete_intent_id)) THEN RETURN NEW; END IF;
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


-- zeros-expand-exception: existing-delete-capture-hold Preserve previous authority and add only the exact existing-Delete loss branch
CREATE OR REPLACE FUNCTION cloud_owner_delete_hold_capture_facts() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt cloud_workspace_owner_delete_receipts;
BEGIN
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE NOWAIT;
  SELECT * INTO receipt FROM cloud_workspace_owner_delete_receipts WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM cloud_workspace_owner_existing_delete_receipts WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id) THEN
      RAISE EXCEPTION 'existing Delete capture facts are retained' USING ERRCODE='40001';
    END IF;
    RETURN NEW;
  END IF;
  -- Lazy legacy adoption may add its reciprocal link in this same admission;
  -- it may not change the retained attempt, state, reports or native retirement.
  IF TG_OP='UPDATE' AND receipt.admission_txid=txid_current() AND receipt.database_principal=current_user
    AND (to_jsonb(NEW)-ARRAY['final_save_recovery_id','final_save_attempt_ordinal'])
      IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['final_save_recovery_id','final_save_attempt_ordinal']) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'owner delete capture facts are retained' USING ERRCODE='40001';
END $$;


-- zeros-expand-exception: existing-delete-data-hold Preserve previous authority and add only the exact existing-Delete loss branch
CREATE OR REPLACE FUNCTION cloud_owner_delete_hold_data() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  PERFORM id FROM cloud_workspaces WHERE id=NEW.workspace_id AND org_id=NEW.org_id FOR UPDATE NOWAIT;
  IF NOT EXISTS (SELECT 1 FROM cloud_workspace_owner_delete_receipts WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id)
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_owner_existing_delete_receipts WHERE workspace_id=NEW.workspace_id AND org_id=NEW.org_id) THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='workspace_checkpoints'
    AND (to_jsonb(NEW)-ARRAY['legal_hold','retention_until']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['legal_hold','retention_until']) THEN RETURN NEW; END IF;
  IF cloud_workspace_data_purge_authorized(NEW.workspace_id,NEW.org_id) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'owner delete data source is closed' USING ERRCODE='40001';
END $$;
