-- zeros-migration: contract
-- zeros-contract-after: 2026-10-21
-- zeros:requires-controlled-downtime
-- Owner-approved cloud v1 retirement, batch 2 of 11; continues 0182.
-- Keep controlled-cutover maintenance until 0200_retire_legacy_cloud_11.sql.
-- Separate transactions bound dependency locks; do not combine these batches.

DROP TABLE IF EXISTS
  cloud_computer_v2_operations,
  cloud_customization,
  cloud_customization_execution_snapshots,
  cloud_device_sessions,
  cloud_github_source_access,
  cloud_github_write_grants,
  cloud_health_alert_state,
  cloud_rollout_flag_changes,
  cloud_rollout_flags,
  cloud_runtime_channel_releases,
  cloud_runtime_qualification_runs,
  cloud_runtime_qualifications,
  cloud_runtime_resident_transfer_qualifications,
  cloud_workspace_action_receipts,
  cloud_workspace_allocation_operations,
  cloud_workspace_allocation_transfers,
  cloud_workspace_command_operations,
  cloud_workspace_commands,
  cloud_workspace_compute_rechecks,
  cloud_workspace_computer_sources,
  cloud_workspace_diagnostic_cleanup,
  cloud_workspace_diagnostic_incidents,
  cloud_workspace_directory_recipients,
  cloud_workspace_engine_uplinks,
  cloud_workspace_final_save_dispatches,
  cloud_workspace_generation_secret_bindings
CASCADE;
