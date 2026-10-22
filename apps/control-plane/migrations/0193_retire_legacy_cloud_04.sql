-- zeros-migration: contract
-- zeros-contract-after: 2026-10-21
-- zeros:requires-controlled-downtime
-- Owner-approved cloud v1 retirement, batch 4 of 11; continues 0182.
-- Keep controlled-cutover maintenance until 0200_retire_legacy_cloud_11.sql.
-- Separate transactions bound dependency locks; do not combine these batches.

DROP TABLE IF EXISTS
  cloud_workspace_provider_loss_attestations,
  cloud_workspace_provider_orphans,
  cloud_workspace_quota_changes,
  cloud_workspace_quotas,
  cloud_workspace_restore_incidents,
  cloud_workspace_runtime_attestations,
  cloud_workspace_runtime_handoffs,
  cloud_workspace_runtime_rollback_restores,
  cloud_workspace_runtime_service_grants,
  cloud_workspace_setup_secrets,
  cloud_workspace_stream_events,
  cloud_workspace_turn_events,
  cloud_workspace_unstarted_candidate_cleanup,
  cloud_workspace_usage_events,
  cloud_workspace_writer_slots,
  control_plane_jobs,
  device_key_rotation_requests,
  device_request_nonces,
  managed_compute_credit_events,
  managed_compute_credit_grants,
  managed_compute_funding_movements,
  managed_compute_pro_allowance_queue,
  managed_compute_pro_allowances,
  managed_compute_provider_requirements
CASCADE;
