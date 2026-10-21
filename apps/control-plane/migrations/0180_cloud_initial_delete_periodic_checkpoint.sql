-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- A ready engine can write an ordinary periodic checkpoint after an initial
-- setup Delete was accepted and before its first capture is admitted. That
-- checkpoint is not save proof for the Delete, which still needs its own
-- before_delete capture. Accept only durable periodic checkpoints from this
-- engine's own lifetime; every other checkpoint, request or proof still refuses.
-- zeros-expand-exception: initial-delete-periodic-source Accept the engine's own periodic checkpoints before the first Delete capture
CREATE OR REPLACE FUNCTION cloud_initial_delete_capture_source(target_intent_id uuid,check_workos boolean DEFAULT true) RETURNS jsonb
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
    AND NOT EXISTS (SELECT 1 FROM workspace_checkpoints c WHERE c.workspace_id=w.id AND c.org_id=w.org_id
      AND NOT (c.reason='periodic' AND c.generation=1 AND c.state='durable' AND c.invalidated_at IS NULL
        AND c.authority_epoch=w.authority_epoch AND c.created_at>=e.registered_at))
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_dispatches d WHERE d.workspace_id=w.id AND d.org_id=w.org_id)
    AND (admitted.lifecycle_intent_id IS NULL OR admitted.admission_txid=txid_current())
$$;
