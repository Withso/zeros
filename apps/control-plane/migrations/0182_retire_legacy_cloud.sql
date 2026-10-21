-- zeros-migration: contract
-- zeros-contract-after: 2026-10-21
-- The owner approved retirement of the old cloud runtime and its data. Deploy
-- only with the v2 control plane/desktop cutover; historical migrations remain
-- immutable so every existing database follows the same upgrade ladder.
-- Retain the Settings vault, Codex renewal ledger, GitHub connections,
-- organization/account entitlements, identity/security data and cloud_v2_*.

-- Finish the old vault's lazy metadata backfill before its delegation source
-- disappears. This preserves imported accounts without carrying workspace
-- delegation or engine authority into v2.
INSERT INTO cloud_agent_credential_organizations(credential_id,org_id,owner_user_id)
SELECT DISTINCT credential.id,delegation.org_id,credential.owner_user_id
FROM cloud_agent_credential_delegations delegation
JOIN cloud_agent_credentials credential ON credential.id=delegation.credential_id AND credential.owner_user_id=delegation.owner_user_id
JOIN organization_members member ON member.org_id=delegation.org_id AND member.user_id=credential.owner_user_id
JOIN organizations organization ON organization.id=member.org_id AND NOT organization.is_personal AND organization.deleted_at IS NULL
WHERE credential.revoked_at IS NULL AND delegation.revoked_at IS NULL
ON CONFLICT DO NOTHING;
UPDATE cloud_agent_credentials credential SET connection_method=CASE
  WHEN credential.kind IN ('claude-setup-token','codex-chatgpt') OR
    (credential.kind='cursor-api-key' AND material.material_expires_at IS NOT NULL) THEN 'account' ELSE 'api' END
FROM cloud_agent_credential_versions material
WHERE material.credential_id=credential.id AND material.version=credential.current_version AND material.material_mode='local';
-- Internal publication fences have no v2 holder. Public removal receipts and
-- their remote Dev broker acknowledgements remain intact.
DELETE FROM cloud_agent_credential_mutations WHERE target->>'kind' IN ('publish-credential','publish-connection');

-- Account entitlement checks are used by Settings, independently of a VM.
CREATE OR REPLACE FUNCTION public.account_pro_entitlement(target_user_id uuid)
 RETURNS TABLE(plan text, revision bigint, valid_from timestamp with time zone, valid_until timestamp with time zone, source text)
 LANGUAGE sql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT eligible.plan,eligible.revision,eligible.valid_from,eligible.valid_until,eligible.source
  FROM users account CROSS JOIN LATERAL (
    SELECT entitlement.plan,entitlement.revision,entitlement.valid_from,entitlement.valid_until,entitlement.source,0 AS priority
    FROM account_entitlements entitlement WHERE entitlement.user_id=account.id AND entitlement.plan='pro'
      AND (entitlement.status IN ('active','trialing') OR (entitlement.status='cancelled' AND entitlement.valid_until IS NOT NULL))
      AND entitlement.cloud_workspaces_allowed AND entitlement.valid_from<=clock_timestamp()
      AND (entitlement.valid_until IS NULL OR entitlement.valid_until>clock_timestamp())
    UNION ALL
    SELECT 'pro',900000000000000+benefit.revision,benefit.valid_from,NULL::timestamptz,'staff',1
    FROM staff_pro_benefits benefit WHERE benefit.user_id=account.id AND benefit.revoked_at IS NULL
      AND account.staff_role IN ('platform_owner','developer')
  ) eligible
  WHERE account.id=target_user_id AND account.auth_status='active' AND account.deleted_at IS NULL
    AND (app_is_system() OR account.id=app_current_user())
  ORDER BY eligible.priority LIMIT 1
$function$
;
CREATE OR REPLACE FUNCTION public.account_pro_user_live(target_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT EXISTS(SELECT 1 FROM account_pro_entitlement(target_user_id))
$function$
;
REVOKE ALL ON FUNCTION account_pro_entitlement(uuid), account_pro_user_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION account_pro_entitlement(uuid), account_pro_user_live(uuid) TO zeros_app;

-- Organization entitlement audit evidence remains append-only during tenant
-- life and is erased only after the retained deletion lifecycle enters purge.
CREATE FUNCTION public.purge_organization_entitlement_configuration(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'system context required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organizations
  WHERE id = p_org_id AND lifecycle_status = 'purging' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization purge state mismatch' USING ERRCODE = '55000';
  END IF;
  DELETE FROM public.cloud_workspace_entitlement_changes WHERE org_id = p_org_id;
END;
$function$;
REVOKE ALL ON FUNCTION purge_organization_entitlement_configuration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_organization_entitlement_configuration(uuid) TO zeros_app;

-- These two triggers serve retained account/security queues; keep their exact
-- behavior and notification channels under names outside the old runtime.
ALTER FUNCTION cloud_actor_staff_revision() RENAME TO account_staff_revision;
ALTER FUNCTION notify_cloud_worker_available() RENAME TO notify_background_work_available;

-- Remove old engine hooks on retained tables before deleting their sources.
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON account_entitlements;
DROP TRIGGER IF EXISTS account_entitlement_cloud_authority_check ON account_entitlements;
DROP TRIGGER IF EXISTS cloud_capability_epoch_account_entitlement_changes ON account_entitlements;
DROP TRIGGER IF EXISTS cloud_capability_epoch_account_entitlements ON account_entitlements;
DROP TRIGGER IF EXISTS account_pro_monthly_allowance ON account_entitlements;
DROP TRIGGER IF EXISTS revoke_disconnected_native_github_grants ON cloud_github_connections;
DROP TRIGGER IF EXISTS organization_entitlement_cloud_authority_check ON organization_entitlements;
DROP TRIGGER IF EXISTS cloud_capability_epoch_organization_entitlements ON organization_entitlements;
DROP TRIGGER IF EXISTS cloud_capability_epoch_organization_entitlement_changes ON organization_entitlements;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON organization_entitlements;
DROP TRIGGER IF EXISTS cloud_workspace_data_org_membership_removed ON organization_members;
DROP TRIGGER IF EXISTS cloud_capability_epoch_org_members_changes ON organization_members;
DROP TRIGGER IF EXISTS cloud_capability_epoch_org_members ON organization_members;
DROP TRIGGER IF EXISTS organization_member_cloud_workspace_access_revoke ON organization_members;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON organization_members;
DROP TRIGGER IF EXISTS organization_membership_cloud_authority_check ON organization_members;
DROP TRIGGER IF EXISTS pro_workspace_guest_membership_removed ON organization_members;
DROP TRIGGER IF EXISTS organization_seat_cloud_authority_check ON organization_seat_assignments;
DROP TRIGGER IF EXISTS cloud_capability_epoch_seat_assignments_changes ON organization_seat_assignments;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON organization_seat_assignments;
DROP TRIGGER IF EXISTS cloud_capability_epoch_seat_assignments ON organization_seat_assignments;
DROP TRIGGER IF EXISTS cloud_capability_epoch_organizations ON organizations;
DROP TRIGGER IF EXISTS organization_cloud_workspace_retirement ON organizations;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON organizations;
DROP TRIGGER IF EXISTS organization_cloud_authority_check ON organizations;
DROP TRIGGER IF EXISTS cloud_capability_epoch_staff_pro_benefits ON staff_pro_benefits;
DROP TRIGGER IF EXISTS cloud_capability_epoch_staff_pro_benefits_changes ON staff_pro_benefits;
DROP TRIGGER IF EXISTS staff_pro_monthly_allowance ON staff_pro_benefits;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON staff_pro_benefits;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON team_members;
DROP TRIGGER IF EXISTS cloud_capability_epoch_team_members_changes ON team_members;
DROP TRIGGER IF EXISTS cloud_capability_epoch_team_members ON team_members;
DROP TRIGGER IF EXISTS cloud_workspace_data_team_membership_removed ON team_members;
DROP TRIGGER IF EXISTS team_membership_cloud_authority_check ON team_members;
DROP TRIGGER IF EXISTS team_member_cloud_workspace_access_revoke ON team_members;
DROP TRIGGER IF EXISTS team_cloud_workspace_retirement ON teams;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON teams;
DROP TRIGGER IF EXISTS cloud_capability_epoch_teams ON teams;
DROP TRIGGER IF EXISTS cloud_capability_epoch_event_accounts ON users;
DROP TRIGGER IF EXISTS user_auth_cloud_authority_check ON users;
DROP TRIGGER IF EXISTS user_cloud_workspace_authority_retirement ON users;
DROP TRIGGER IF EXISTS user_staff_cloud_authority_check ON users;
DROP TRIGGER IF EXISTS cloud_capability_epoch_users ON users;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON users;
DROP TRIGGER IF EXISTS workos_link_cloud_authority_check ON workos_organization_links;
DROP TRIGGER IF EXISTS zz_cloud_authority_cache ON workos_organization_links;

-- This is the sole FK from a retained table into the retired workspace graph.
-- Account and organization security events are preserved; obsolete workspace
-- events have no remaining catalog or authority consumer.
DELETE FROM security_events WHERE workspace_id IS NOT NULL;
ALTER TABLE security_events DROP CONSTRAINT IF EXISTS security_events_workspace_scope;

-- The explicit list also removes each table's RLS policies and triggers.
-- CASCADE handles row-returning old functions, all listed again below.
DROP TABLE IF EXISTS
  cloud_accepted_work_enrollments,
  cloud_agent_adoption_key_policy,
  cloud_agent_adoption_keys,
  cloud_agent_adoption_retired_owners,
  cloud_agent_adoptions,
  cloud_agent_background_tasks,
  cloud_agent_boot_bindings,
  cloud_agent_boot_contexts,
  cloud_agent_boot_credentials,
  cloud_agent_boot_refreshes,
  cloud_agent_boot_source_deliveries,
  cloud_agent_checkpoint_history_snapshots,
  cloud_agent_credential_controls,
  cloud_agent_credential_delegations,
  cloud_agent_credential_source_retirements,
  cloud_agent_execution_leases,
  cloud_agent_funding_consents,
  cloud_agent_history_recoveries,
  cloud_agent_runtime_qualification_changes,
  cloud_agent_runtime_qualifications,
  cloud_builder_vm_create_attempts,
  cloud_builder_vm_operations,
  cloud_capability_access_losses,
  cloud_capability_key_changes,
  cloud_capability_member_epochs,
  cloud_capability_signing_keys,
  cloud_computer_admin_workspace_requests,
  cloud_computer_admin_workspaces,
  cloud_computer_build_logs,
  cloud_computer_build_qualifications,
  cloud_computer_builds,
  cloud_computer_environment_refs,
  cloud_computer_image_base_references,
  cloud_computer_image_create_attempts,
  cloud_computer_images,
  cloud_computer_template_snapshots,
  cloud_computer_templates,
  cloud_computer_v2_builds,
  cloud_computer_v2_config_repositories,
  cloud_computer_v2_configs,
  cloud_computer_v2_heads,
  cloud_computer_v2_operations,
  cloud_computers,
  cloud_customization,
  cloud_customization_execution_snapshots,
  cloud_device_sessions,
  cloud_github_source_access,
  cloud_github_write_grants,
  cloud_health_alert_state,
  cloud_rollout_flag_changes,
  cloud_rollout_flags,
  cloud_runtime_base_contracts,
  cloud_runtime_base_images,
  cloud_runtime_bundles,
  cloud_runtime_channel_releases,
  cloud_runtime_images,
  cloud_runtime_qualification_runs,
  cloud_runtime_qualifications,
  cloud_runtime_resident_transfer_qualifications,
  cloud_runtime_transfer_qualifications,
  cloud_workspace_action_receipts,
  cloud_workspace_actor_sessions,
  cloud_workspace_allocation_operations,
  cloud_workspace_allocation_owners,
  cloud_workspace_allocation_transfers,
  cloud_workspace_client_access_grants,
  cloud_workspace_command_operations,
  cloud_workspace_commands,
  cloud_workspace_compute_rechecks,
  cloud_workspace_computer_sources,
  cloud_workspace_conversation_controls,
  cloud_workspace_diagnostic_cleanup,
  cloud_workspace_diagnostic_incidents,
  cloud_workspace_directory_outbox,
  cloud_workspace_directory_recipients,
  cloud_workspace_endpoint_grants,
  cloud_workspace_engine_instances,
  cloud_workspace_engine_uplinks,
  cloud_workspace_event_streams,
  cloud_workspace_final_save_dispatches,
  cloud_workspace_final_save_recoveries,
  cloud_workspace_generation_secret_bindings,
  cloud_workspace_generation_transitions,
  cloud_workspace_generations,
  cloud_workspace_guest_grants,
  cloud_workspace_initial_delete_captures,
  cloud_workspace_invitation_deliveries,
  cloud_workspace_invitations,
  cloud_workspace_lifecycle_allocation_waits,
  cloud_workspace_lifecycle_intents,
  cloud_workspace_local_agent_controls,
  cloud_workspace_local_command_controls,
  cloud_workspace_local_command_history_blobs,
  cloud_workspace_local_command_history_heads,
  cloud_workspace_local_command_history_parts,
  cloud_workspace_local_command_mirror_batches,
  cloud_workspace_local_command_writers,
  cloud_workspace_local_commands,
  cloud_workspace_members,
  cloud_workspace_metadata_requests,
  cloud_workspace_object_rotation_retry_changes,
  cloud_workspace_object_storage_limit_changes,
  cloud_workspace_object_storage_limits,
  cloud_workspace_outbox,
  cloud_workspace_owner_delete_dispositions,
  cloud_workspace_owner_delete_receipts,
  cloud_workspace_owner_discard_receipts,
  cloud_workspace_owner_existing_delete_receipts,
  cloud_workspace_owner_recovery_retries,
  cloud_workspace_ownership_transfers,
  cloud_workspace_paid_authority_checks,
  cloud_workspace_provider_absence_attestations,
  cloud_workspace_provider_bindings,
  cloud_workspace_provider_create_attempts,
  cloud_workspace_provider_loss_attestations,
  cloud_workspace_provider_operations,
  cloud_workspace_provider_orphans,
  cloud_workspace_quota_changes,
  cloud_workspace_quotas,
  cloud_workspace_restore_incidents,
  cloud_workspace_runtime_attestations,
  cloud_workspace_runtime_enrollments,
  cloud_workspace_runtime_handoffs,
  cloud_workspace_runtime_rollback_refs,
  cloud_workspace_runtime_rollback_restores,
  cloud_workspace_runtime_service_grants,
  cloud_workspace_runtime_transitions,
  cloud_workspace_setup_attestations,
  cloud_workspace_setup_runs,
  cloud_workspace_setup_secrets,
  cloud_workspace_setup_specs,
  cloud_workspace_stream_events,
  cloud_workspace_turn_events,
  cloud_workspace_unstarted_candidate_cleanup,
  cloud_workspace_usage_events,
  cloud_workspace_writer_slots,
  cloud_workspaces,
  control_plane_jobs,
  device_key_rotation_requests,
  device_request_nonces,
  devices,
  environment_profile_versions,
  environment_profiles,
  managed_compute_allocation_leases,
  managed_compute_credit_accounts,
  managed_compute_credit_events,
  managed_compute_credit_grants,
  managed_compute_credit_periods,
  managed_compute_credit_reservations,
  managed_compute_funding_movements,
  managed_compute_funding_receipts,
  managed_compute_pro_accounts,
  managed_compute_pro_allowance_queue,
  managed_compute_pro_allowances,
  managed_compute_provider_requirements,
  managed_compute_reservation_scopes,
  managed_compute_staff_allowance_receipts,
  managed_compute_usage_disagreements,
  managed_compute_user_accounts,
  managed_compute_user_periods,
  organization_cloud_policy_heads,
  organization_cloud_policy_versions,
  personal_profile_inheritance_consents,
  port_forward_sessions,
  provider_connection_versions,
  provider_connections,
  repositories,
  repository_settings_heads,
  repository_settings_versions,
  secret_binding_versions,
  secret_bindings,
  workspace_billing_epochs,
  workspace_blob_object_deletions,
  workspace_blob_references,
  workspace_blob_rotation_jobs,
  workspace_blob_storage_reservations,
  workspace_blobs,
  workspace_checkpoint_entries,
  workspace_checkpoint_requests,
  workspace_checkpoints,
  workspace_content_heads,
  workspace_content_revisions,
  workspace_deletion_blob_targets,
  workspace_deletion_jobs,
  workspace_executions,
  workspace_export_grants,
  workspace_exports,
  workspace_file_entries,
  workspace_file_events,
  workspace_fork_import_entries,
  workspace_fork_import_records,
  workspace_fork_intents,
  workspace_ports,
  workspace_record_batches,
  workspace_record_entities,
  workspace_record_events,
  workspace_record_heads,
  workspace_replica_commands,
  workspace_replica_events,
  workspace_replica_grants,
  workspace_replica_receipts,
  workspace_replicas,
  workspace_retention_policies,
  workspace_settings_versions,
  workspace_setup_recovery_grants
CASCADE;

-- PL/pgSQL bodies do not record relation dependencies, so drop the old
-- functions explicitly rather than leave executable references to gone tables.
DROP FUNCTION IF EXISTS account_workspace_blob_reference();
DROP FUNCTION IF EXISTS admit_cloud_initial_delete_capture(target_intent_id uuid, expected_source_sha256 bytea, check_workos boolean);
DROP FUNCTION IF EXISTS adopt_cloud_unstarted_candidate_cleanup(target_intent_id uuid);
DROP FUNCTION IF EXISTS bind_cloud_computer_image();
DROP FUNCTION IF EXISTS bind_cloud_generation_named_computer();
DROP FUNCTION IF EXISTS bind_cloud_workspace_intent_generation();
DROP FUNCTION IF EXISTS bind_cloud_workspace_provider_binding();
DROP FUNCTION IF EXISTS bind_cloud_workspace_provider_version();
DROP FUNCTION IF EXISTS bound_cloud_agent_adoptions();
DROP FUNCTION IF EXISTS bump_cloud_capability_invitation_epoch();
DROP FUNCTION IF EXISTS bump_cloud_capability_member_epoch(target_org uuid, target_user uuid);
DROP FUNCTION IF EXISTS bump_cloud_capability_member_epoch_trigger();
DROP FUNCTION IF EXISTS bump_cloud_capability_org_epochs(target_org uuid);
DROP FUNCTION IF EXISTS bump_cloud_capability_org_epochs_trigger();
DROP FUNCTION IF EXISTS bump_cloud_capability_user_epochs(target_user uuid);
DROP FUNCTION IF EXISTS bump_cloud_capability_user_epochs_trigger();
DROP FUNCTION IF EXISTS bump_cloud_capability_writer_slot_epoch();
DROP FUNCTION IF EXISTS cloud_accepted_lifecycle_changed();
DROP FUNCTION IF EXISTS cloud_accepted_lifecycle_scope();
DROP FUNCTION IF EXISTS cloud_accepted_work_key_live(target_kid text);
DROP FUNCTION IF EXISTS cloud_capability_actor_signing_keys_live(kids text[]);
DROP FUNCTION IF EXISTS cloud_compute_lease_jobs();
DROP FUNCTION IF EXISTS cloud_compute_recheck_jobs();
DROP FUNCTION IF EXISTS cloud_computer_build_handoff_guard();
DROP FUNCTION IF EXISTS cloud_computer_template_builder_guard();
DROP FUNCTION IF EXISTS cloud_computer_template_source_guard();
DROP FUNCTION IF EXISTS cloud_computer_v2_build_identity_guard();
DROP FUNCTION IF EXISTS cloud_computer_v2_config_child_guard();
DROP FUNCTION IF EXISTS cloud_computer_v2_config_immutable();
DROP FUNCTION IF EXISTS cloud_computer_v2_enable_guard();
DROP FUNCTION IF EXISTS cloud_computer_v2_fence_legacy_write();
DROP FUNCTION IF EXISTS cloud_computer_v2_purge_allowed(p_org_id uuid);
DROP FUNCTION IF EXISTS cloud_coordinator_readiness_job();
DROP FUNCTION IF EXISTS cloud_diagnostic_cleanup_jobs();
DROP FUNCTION IF EXISTS cloud_drift_binding_jobs();
DROP FUNCTION IF EXISTS cloud_drift_inspect_request();
DROP FUNCTION IF EXISTS cloud_drift_restore_jobs();
DROP FUNCTION IF EXISTS cloud_engine_health_jobs();
DROP FUNCTION IF EXISTS cloud_final_save_admitted();
DROP FUNCTION IF EXISTS cloud_final_save_adopt_proof(target_intent_id uuid);
DROP FUNCTION IF EXISTS cloud_final_save_attempt_immutable();
DROP FUNCTION IF EXISTS cloud_final_save_attempt_settled();
DROP FUNCTION IF EXISTS cloud_final_save_committed();
DROP FUNCTION IF EXISTS cloud_final_save_deletion_claimable(target_workspace_id uuid, target_org_id uuid);
DROP FUNCTION IF EXISTS cloud_final_save_dispatch_claimed();
DROP FUNCTION IF EXISTS cloud_final_save_dispatchable(target_intent_id uuid);
DROP FUNCTION IF EXISTS cloud_final_save_failure_audit();
DROP FUNCTION IF EXISTS cloud_final_save_hold_source();
DROP FUNCTION IF EXISTS cloud_final_save_jobs();
DROP FUNCTION IF EXISTS cloud_final_save_owner_discarded(target_intent_id uuid);
DROP FUNCTION IF EXISTS cloud_final_save_preserve_candidate();
DROP FUNCTION IF EXISTS cloud_final_save_preserve_lifecycle();
DROP FUNCTION IF EXISTS cloud_final_save_preserve_transition();
DROP FUNCTION IF EXISTS cloud_final_save_protect_erasure();
DROP FUNCTION IF EXISTS cloud_final_save_proven(target_intent_id uuid);
DROP FUNCTION IF EXISTS cloud_final_save_request_erased();
DROP FUNCTION IF EXISTS cloud_final_save_request_erasure();
DROP FUNCTION IF EXISTS cloud_final_save_request_link();
DROP FUNCTION IF EXISTS cloud_final_save_require_dispatch();
DROP FUNCTION IF EXISTS cloud_final_save_retired_compute_stop(target_intent_id uuid);
DROP FUNCTION IF EXISTS cloud_final_save_source_immutable();
DROP FUNCTION IF EXISTS cloud_initial_delete_capture_source(target_intent_id uuid, check_workos boolean);
DROP FUNCTION IF EXISTS cloud_lifecycle_admission_jobs();
DROP FUNCTION IF EXISTS cloud_lifecycle_allocation_scope_jobs();
DROP FUNCTION IF EXISTS cloud_lifecycle_allocation_settled_jobs();
DROP FUNCTION IF EXISTS cloud_lifecycle_allocation_wait_jobs();
DROP FUNCTION IF EXISTS cloud_lifecycle_allocation_wait_status(target_intent uuid);
DROP FUNCTION IF EXISTS cloud_lifecycle_intent_jobs();
DROP FUNCTION IF EXISTS cloud_owner_delete_captured_idle_history(target_intent_id uuid);
DROP FUNCTION IF EXISTS cloud_owner_delete_current(target_intent_id uuid);
DROP FUNCTION IF EXISTS cloud_owner_delete_hold_capture_facts();
DROP FUNCTION IF EXISTS cloud_owner_delete_hold_data();
DROP FUNCTION IF EXISTS cloud_owner_delete_hold_intent();
DROP FUNCTION IF EXISTS cloud_owner_delete_hold_source();
DROP FUNCTION IF EXISTS cloud_owner_delete_lock_recovery_source();
DROP FUNCTION IF EXISTS cloud_owner_delete_source(target_stop_id uuid);
DROP FUNCTION IF EXISTS cloud_owner_discard_history_receipt(target_engine_id uuid);
DROP FUNCTION IF EXISTS cloud_owner_discard_hold_capture();
DROP FUNCTION IF EXISTS cloud_owner_discard_recovery_digest(target_intent_id uuid);
DROP FUNCTION IF EXISTS cloud_owner_discard_retire_intent();
DROP FUNCTION IF EXISTS cloud_owner_discard_safety_stop_matches(target_workspace_id uuid, target_org_id uuid, target_generation integer, original_stop_id uuid, original_wake_id uuid, safety_stop_id uuid, safety_request_id uuid, safety_digest bytea);
DROP FUNCTION IF EXISTS cloud_owner_discard_skip_lost_cleanup();
DROP FUNCTION IF EXISTS cloud_owner_discard_transition_receipt(transition_id uuid, workspace_id uuid, org_id uuid, source_generation integer);
DROP FUNCTION IF EXISTS cloud_owner_existing_delete_completed(target_intent_id uuid);
DROP FUNCTION IF EXISTS cloud_owner_existing_delete_current(target_intent_id uuid);
DROP FUNCTION IF EXISTS cloud_owner_existing_delete_hold_intent();
DROP FUNCTION IF EXISTS cloud_owner_existing_delete_hold_projection();
DROP FUNCTION IF EXISTS cloud_owner_existing_delete_source(target_delete_id uuid, target_recovery_id uuid);
DROP FUNCTION IF EXISTS cloud_owner_recovery_retry_ready(owner_id uuid, failed_id uuid, stop_id uuid, delete_id uuid);
DROP FUNCTION IF EXISTS cloud_paid_authority_jobs();
DROP FUNCTION IF EXISTS cloud_provider_allocation_lost(target_workspace_id uuid, target_generation integer, target_org_id uuid, target_resource_id text);
DROP FUNCTION IF EXISTS cloud_provider_create_absence_confirmed(target_provider text, target_account_scope text, target_workspace_id uuid, target_generation integer, attempts_tracked boolean);
DROP FUNCTION IF EXISTS cloud_provider_create_dispatch_active(target_workspace_id uuid, target_generation integer);
DROP FUNCTION IF EXISTS cloud_provider_create_dispatch_horizon(target_provider text, target_account_scope text, target_workspace_id uuid, target_generation integer, attempts_tracked boolean);
DROP FUNCTION IF EXISTS cloud_restart_prerequisite_scope();
DROP FUNCTION IF EXISTS cloud_restart_ready(target_intent_id uuid);
DROP FUNCTION IF EXISTS cloud_runtime_transfer_qualified(source_id text, target_id text, controller_id text, compatibility_id text, execution_mode text, required_mode text);
DROP FUNCTION IF EXISTS cloud_runtime_transition_jobs();
DROP FUNCTION IF EXISTS cloud_unstarted_candidate_current(target_intent_id uuid);
DROP FUNCTION IF EXISTS cloud_unstarted_candidate_hold_capture();
DROP FUNCTION IF EXISTS cloud_unstarted_candidate_hold_source();
DROP FUNCTION IF EXISTS cloud_unstarted_candidate_source(target_intent_id uuid);
DROP FUNCTION IF EXISTS cloud_workspace_accepted_lifecycle(target_workspace_id uuid, target_org_id uuid);
DROP FUNCTION IF EXISTS cloud_workspace_actor_auth_live(target_user_id uuid, source_provider text, source_subject text, source_session_id text, source_session_created_at timestamp with time zone);
DROP FUNCTION IF EXISTS cloud_workspace_actor_fingerprint(target_workspace_id uuid, target_user_id uuid);
DROP FUNCTION IF EXISTS cloud_workspace_actor_role(target_workspace_id uuid, target_user_id uuid);
DROP FUNCTION IF EXISTS cloud_workspace_actor_session_source_live(session cloud_workspace_actor_sessions, required_scope text, current_session boolean, capability_enabled boolean);
DROP FUNCTION IF EXISTS cloud_workspace_compute_authority_live(target_workspace_id uuid, target_generation integer);
DROP FUNCTION IF EXISTS cloud_workspace_data_purge_authorized(target_workspace_id uuid, target_org_id uuid);
DROP FUNCTION IF EXISTS cloud_workspace_drain_is_mandatory(target_intent_id uuid);
DROP FUNCTION IF EXISTS cloud_workspace_engine_authority_current(target_workspace_id uuid, target_org_id uuid, target_generation integer, target_engine_id uuid, require_workos boolean, exclusive boolean);
DROP FUNCTION IF EXISTS cloud_workspace_engine_authority_snapshot(target_workspace_id uuid, target_org_id uuid, target_generation integer, target_engine_id uuid, require_workos boolean);
DROP FUNCTION IF EXISTS cloud_workspace_engine_interactive_live(engine cloud_workspace_engine_instances);
DROP FUNCTION IF EXISTS cloud_workspace_fail_dependent_wakes();
DROP FUNCTION IF EXISTS cloud_workspace_fence_final_checkpoint();
DROP FUNCTION IF EXISTS cloud_workspace_fence_quarantined_intent();
DROP FUNCTION IF EXISTS cloud_workspace_fence_quarantined_workspace();
DROP FUNCTION IF EXISTS cloud_workspace_generation_policy_current(target_workspace_id uuid, target_generation integer, target_org_id uuid);
DROP FUNCTION IF EXISTS cloud_workspace_generation_provider_authority_live(target_workspace_id uuid, target_generation integer, minimum_remaining_seconds integer);
DROP FUNCTION IF EXISTS cloud_workspace_generation_quarantined(target_workspace_id uuid, target_generation integer, target_org_id uuid);
DROP FUNCTION IF EXISTS cloud_workspace_interactive_live(target_workspace uuid, target_org uuid, target_generation integer);
DROP FUNCTION IF EXISTS cloud_workspace_legacy_actor_role(target_workspace_id uuid, target_user_id uuid);
DROP FUNCTION IF EXISTS cloud_workspace_lifecycle_jobs();
DROP FUNCTION IF EXISTS cloud_workspace_paid_authority_live(target_workspace_id uuid, target_user_id uuid, require_workos boolean);
DROP FUNCTION IF EXISTS cloud_workspace_pilot_user_live(target_user_id uuid);
DROP FUNCTION IF EXISTS cloud_workspace_preserve_capture_deadline();
DROP FUNCTION IF EXISTS cloud_workspace_preserve_committed_drain();
DROP FUNCTION IF EXISTS cloud_workspace_preserve_drain_response();
DROP FUNCTION IF EXISTS cloud_workspace_preserve_mandatory_drain();
DROP FUNCTION IF EXISTS cloud_workspace_preserve_mandatory_wake();
DROP FUNCTION IF EXISTS cloud_workspace_pro_entitlement(target_user_id uuid);
DROP FUNCTION IF EXISTS cloud_workspace_pro_sponsor_immutable();
DROP FUNCTION IF EXISTS cloud_workspace_pro_user_live(target_user_id uuid);
DROP FUNCTION IF EXISTS cloud_workspace_read_role(target_workspace_id uuid, target_user_id uuid);
DROP FUNCTION IF EXISTS cloud_workspace_reject_recovery_rollback();
DROP FUNCTION IF EXISTS cloud_workspace_require_completed_drain();
DROP FUNCTION IF EXISTS cloud_workspace_require_retired_wake_source();
DROP FUNCTION IF EXISTS cloud_workspace_runtime_authority_live(target_workspace_id uuid, target_generation integer, target_user_id uuid, require_workos boolean);
DROP FUNCTION IF EXISTS cloud_workspace_setup_timings_valid(value jsonb);
DROP FUNCTION IF EXISTS cloud_workspace_writer_slot_owner();
DROP FUNCTION IF EXISTS drain_cloud_workspaces_for_deleted_organization();
DROP FUNCTION IF EXISTS drain_cloud_workspaces_for_deleted_scope(scope_org_id uuid, scope_team_id uuid, scope_owner_user_id uuid, retirement_reason text);
DROP FUNCTION IF EXISTS drain_cloud_workspaces_for_deleted_team();
DROP FUNCTION IF EXISTS enforce_cloud_allocation_owner();
DROP FUNCTION IF EXISTS enforce_cloud_attestation_runtime_binding();
DROP FUNCTION IF EXISTS enforce_cloud_engine_current_setup_fence();
DROP FUNCTION IF EXISTS enforce_cloud_engine_runtime_binding();
DROP FUNCTION IF EXISTS enforce_cloud_engine_transition_binding();
DROP FUNCTION IF EXISTS enforce_cloud_retained_transition();
DROP FUNCTION IF EXISTS enforce_cloud_runtime_enrollment_identity();
DROP FUNCTION IF EXISTS enforce_cloud_setup_retry_retirement();
DROP FUNCTION IF EXISTS enforce_cloud_workspace_member_owners();
DROP FUNCTION IF EXISTS enforce_cloud_workspace_setup_attestation_binding();
DROP FUNCTION IF EXISTS enforce_cloud_workspace_setup_engine_attestation();
DROP FUNCTION IF EXISTS enforce_cloud_workspace_setup_grant_binding();
DROP FUNCTION IF EXISTS enqueue_cloud_authority_for_account_change();
DROP FUNCTION IF EXISTS enqueue_cloud_authority_for_membership_change();
DROP FUNCTION IF EXISTS enqueue_cloud_authority_for_organization_change();
DROP FUNCTION IF EXISTS enqueue_cloud_authority_for_organization_entitlement_change();
DROP FUNCTION IF EXISTS enqueue_cloud_authority_for_seat_change();
DROP FUNCTION IF EXISTS enqueue_cloud_authority_for_team_membership_change();
DROP FUNCTION IF EXISTS enqueue_cloud_authority_for_user_auth_change();
DROP FUNCTION IF EXISTS enqueue_cloud_authority_for_workos_link_change();
DROP FUNCTION IF EXISTS enqueue_cloud_authority_for_workspace_membership_change();
DROP FUNCTION IF EXISTS enqueue_cloud_generation_provider_authority_check();
DROP FUNCTION IF EXISTS enqueue_cloud_lifecycle_job(job_kind text, scope_workspace_id uuid, scope_org_id uuid, due_at timestamp with time zone);
DROP FUNCTION IF EXISTS enqueue_cloud_provider_connection_authority_check();
DROP FUNCTION IF EXISTS enqueue_cloud_provider_version_authority_check();
DROP FUNCTION IF EXISTS enqueue_cloud_workspace_directory_change();
DROP FUNCTION IF EXISTS enqueue_cloud_workspace_generation_authority_check();
DROP FUNCTION IF EXISTS enqueue_cloud_workspace_paid_authority_checks(scope_org_id uuid, scope_user_id uuid, invalidation_reason text);
DROP FUNCTION IF EXISTS enqueue_pro_monthly_allowance();
DROP FUNCTION IF EXISTS ensure_cloud_final_save_recovery(target_intent_id uuid);
DROP FUNCTION IF EXISTS fence_cloud_computer_image_build();
DROP FUNCTION IF EXISTS guard_cloud_builder_create_attempt();
DROP FUNCTION IF EXISTS guard_cloud_builder_create_closure();
DROP FUNCTION IF EXISTS guard_cloud_initial_delete_capture();
DROP FUNCTION IF EXISTS guard_cloud_owner_delete_disposition();
DROP FUNCTION IF EXISTS guard_cloud_owner_delete_receipt();
DROP FUNCTION IF EXISTS guard_cloud_owner_discard_receipt();
DROP FUNCTION IF EXISTS guard_cloud_owner_existing_delete_receipt();
DROP FUNCTION IF EXISTS guard_cloud_provider_absence_attestation();
DROP FUNCTION IF EXISTS guard_cloud_provider_create_attempt();
DROP FUNCTION IF EXISTS guard_cloud_provider_loss_attestation();
DROP FUNCTION IF EXISTS guard_cloud_unstarted_candidate_receipt();
DROP FUNCTION IF EXISTS guard_cloud_workspace_provider_operation();
DROP FUNCTION IF EXISTS guard_pro_allowance_topup();
DROP FUNCTION IF EXISTS initialize_cloud_workspace_owner_slot();
DROP FUNCTION IF EXISTS maintain_cloud_workspace_authority_check();
DROP FUNCTION IF EXISTS managed_compute_funding_identity_immutable();
DROP FUNCTION IF EXISTS notify_cloud_agent_credential_revision();
DROP FUNCTION IF EXISTS notify_cloud_authority_cache();
DROP FUNCTION IF EXISTS notify_cloud_engine_uplink_authority();
DROP FUNCTION IF EXISTS notify_cloud_engine_uplink_owner();
DROP FUNCTION IF EXISTS notify_cloud_workspace_catalog();
DROP FUNCTION IF EXISTS personal_organization_has_cloud_configuration(p_account_id uuid);
DROP FUNCTION IF EXISTS preserve_cloud_accepted_work();
DROP FUNCTION IF EXISTS preserve_cloud_agent_adoption();
DROP FUNCTION IF EXISTS preserve_cloud_agent_adoption_key();
DROP FUNCTION IF EXISTS preserve_cloud_agent_adoption_key_policy();
DROP FUNCTION IF EXISTS preserve_cloud_agent_adoption_retired_owner();
DROP FUNCTION IF EXISTS preserve_cloud_agent_boot_binding();
DROP FUNCTION IF EXISTS preserve_cloud_agent_control();
DROP FUNCTION IF EXISTS preserve_cloud_agent_history_recovery();
DROP FUNCTION IF EXISTS preserve_cloud_agent_source_delivery();
DROP FUNCTION IF EXISTS preserve_cloud_agent_source_retirement();
DROP FUNCTION IF EXISTS preserve_cloud_builder_vm_operation();
DROP FUNCTION IF EXISTS preserve_cloud_capability_actor_session();
DROP FUNCTION IF EXISTS preserve_cloud_capability_key();
DROP FUNCTION IF EXISTS preserve_cloud_checkpoint_history_snapshot();
DROP FUNCTION IF EXISTS preserve_cloud_computer_build_qualification();
DROP FUNCTION IF EXISTS preserve_cloud_computer_named_snapshot();
DROP FUNCTION IF EXISTS preserve_cloud_engine_enrollment_kind();
DROP FUNCTION IF EXISTS preserve_cloud_generation_runtime_pin();
DROP FUNCTION IF EXISTS preserve_cloud_generation_sandbox_class();
DROP FUNCTION IF EXISTS preserve_cloud_lifecycle_allocation_wait();
DROP FUNCTION IF EXISTS preserve_cloud_local_command_terminal();
DROP FUNCTION IF EXISTS preserve_cloud_local_command_writer();
DROP FUNCTION IF EXISTS preserve_cloud_local_history_head();
DROP FUNCTION IF EXISTS preserve_cloud_local_mirror_ack();
DROP FUNCTION IF EXISTS preserve_cloud_local_writer_seal();
DROP FUNCTION IF EXISTS preserve_cloud_owner_recovery_retry();
DROP FUNCTION IF EXISTS preserve_cloud_runtime_handoff();
DROP FUNCTION IF EXISTS preserve_cloud_runtime_image();
DROP FUNCTION IF EXISTS preserve_cloud_runtime_registry_row();
DROP FUNCTION IF EXISTS preserve_cloud_runtime_rollback_pin();
DROP FUNCTION IF EXISTS preserve_cloud_runtime_transition_identity();
DROP FUNCTION IF EXISTS protect_cloud_computer_base_reference();
DROP FUNCTION IF EXISTS protect_cloud_computer_base_retirement();
DROP FUNCTION IF EXISTS provision_cloud_workspace_pro_defaults(target_org_id uuid);
DROP FUNCTION IF EXISTS purge_cloud_compute_rechecks();
DROP FUNCTION IF EXISTS purge_cloud_lifecycle_allocation_waits();
DROP FUNCTION IF EXISTS purge_cloud_workspace_operator_configuration(p_org_id uuid);
DROP FUNCTION IF EXISTS recheck_cloud_workspace_compute_leases();
DROP FUNCTION IF EXISTS record_cloud_capability_access_loss(target_workspace uuid, target_org uuid, target_user uuid);
DROP FUNCTION IF EXISTS record_cloud_capability_epoch_event(target_org uuid, target_user uuid, detail jsonb);
DROP FUNCTION IF EXISTS record_cloud_capability_epoch_event_trigger();
DROP FUNCTION IF EXISTS recover_cloud_workspace_diagnostics();
DROP FUNCTION IF EXISTS reject_cloud_agent_runtime_qualification_change_mutation();
DROP FUNCTION IF EXISTS reject_cloud_capability_key_change_mutation();
DROP FUNCTION IF EXISTS reject_cloud_provider_absence_attestation_truncate();
DROP FUNCTION IF EXISTS reject_cloud_rollout_flag_change_mutation();
DROP FUNCTION IF EXISTS reject_cloud_workspace_object_rotation_retry_change_mutation();
DROP FUNCTION IF EXISTS reject_cloud_workspace_object_storage_limit_change_mutation();
DROP FUNCTION IF EXISTS reject_cloud_workspace_quota_change_mutation();
DROP FUNCTION IF EXISTS reject_cloud_workspace_setup_attestation_update();
DROP FUNCTION IF EXISTS reject_cloud_workspace_setup_spec_update();
DROP FUNCTION IF EXISTS reject_cloud_workspace_usage_mutation();
DROP FUNCTION IF EXISTS reject_immutable_cloud_record_mutation();
DROP FUNCTION IF EXISTS reject_immutable_workspace_record();
DROP FUNCTION IF EXISTS reject_personal_cloud_workspace();
DROP FUNCTION IF EXISTS release_workspace_blob_reference_reservation();
DROP FUNCTION IF EXISTS request_cloud_workspace_drift_inspect(scope_workspace_id uuid);
DROP FUNCTION IF EXISTS require_cloud_computer_named_publication();
DROP FUNCTION IF EXISTS require_cloud_initial_delete_capture();
DROP FUNCTION IF EXISTS require_cloud_lifecycle_allocation_dependency();
DROP FUNCTION IF EXISTS require_cloud_owner_delete_atomic();
DROP FUNCTION IF EXISTS require_cloud_owner_discard_transition();
DROP FUNCTION IF EXISTS require_cloud_owner_existing_delete_atomic();
DROP FUNCTION IF EXISTS require_cloud_owner_recovery_retry_transition();
DROP FUNCTION IF EXISTS require_cloud_snapshot_recovery_computer();
DROP FUNCTION IF EXISTS require_cloud_unstarted_candidate_retirement();
DROP FUNCTION IF EXISTS reserve_workspace_blob_rotation_storage(p_blob_id uuid, p_org_id uuid, p_target_key_version integer);
DROP FUNCTION IF EXISTS reserve_workspace_blob_storage(p_workspace_id uuid, p_org_id uuid, p_blob_id uuid, p_reserve_physical boolean, p_reference_state text);
DROP FUNCTION IF EXISTS reserve_workspace_blob_storage_batch(p_workspace_id uuid, p_org_id uuid, p_blob_ids uuid[], p_reserve_physical boolean);
DROP FUNCTION IF EXISTS retire_cloud_lifecycle_allocation_wait();
DROP FUNCTION IF EXISTS retire_cloud_workspace_authority_for_deleted_user();
DROP FUNCTION IF EXISTS retire_cloud_workspace_execution_projection();
DROP FUNCTION IF EXISTS retire_cloud_workspace_managed_policy_authority();
DROP FUNCTION IF EXISTS retire_cloud_workspace_provider_connection_authority();
DROP FUNCTION IF EXISTS retire_cloud_workspace_secret_binding_authority();
DROP FUNCTION IF EXISTS revoke_cloud_workspace_access_for_org_member();
DROP FUNCTION IF EXISTS revoke_cloud_workspace_access_for_team_member();
DROP FUNCTION IF EXISTS revoke_cloud_workspace_data_for_membership();
DROP FUNCTION IF EXISTS revoke_disconnected_native_github_grants();
DROP FUNCTION IF EXISTS revoke_port_forward_access_for_device();
DROP FUNCTION IF EXISTS revoke_pro_workspace_guest_on_membership_removal();
DROP FUNCTION IF EXISTS stamp_cloud_agent_funding_owner_epoch();
DROP FUNCTION IF EXISTS stamp_cloud_engine_enrollment_order();
DROP FUNCTION IF EXISTS stamp_workspace_blob_dereference();
DROP FUNCTION IF EXISTS sync_cloud_workspace_execution_projection();
DROP FUNCTION IF EXISTS sync_port_forward_session_access_state();
DROP FUNCTION IF EXISTS track_cloud_provider_deletion_progress();
DROP FUNCTION IF EXISTS verify_cloud_agent_boot_pointer();
DROP FUNCTION IF EXISTS verify_cloud_allocation_transfer();
DROP FUNCTION IF EXISTS verify_cloud_allocation_transfer_runtime();
DROP FUNCTION IF EXISTS verify_cloud_runtime_health_attestation();
