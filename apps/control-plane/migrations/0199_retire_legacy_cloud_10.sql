-- zeros-migration: contract
-- zeros-contract-after: 2026-10-21
-- zeros:requires-controlled-downtime
-- Owner-approved cloud v1 retirement, batch 10 of 11; continues 0182.
-- Keep controlled-cutover maintenance until 0200_retire_legacy_cloud_11.sql.
-- Separate transactions bound dependency locks; do not combine these batches.

DROP TABLE IF EXISTS
  cloud_workspaces,
  repositories,
  workspace_billing_epochs,
  environment_profile_versions,
  environment_profiles,
  provider_connection_versions,
  provider_connections,
  secret_binding_versions,
  secret_bindings,
  workspace_blobs,
  workspace_checkpoints,
  workspace_content_revisions,
  workspace_content_heads,
  workspace_exports,
  workspace_fork_intents
CASCADE;

-- PL/pgSQL bodies do not record relation dependencies. Explicitly remove
-- old functions after their tables, policies and triggers have gone.
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
