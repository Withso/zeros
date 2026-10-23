-- zeros-migration: contract
-- zeros-contract-after: 2026-10-21
-- zeros:requires-controlled-downtime
-- Owner-approved cloud v1 retirement, batch 9 of 11; continues 0182.
-- Keep controlled-cutover maintenance until 0200_retire_legacy_cloud_11.sql.
-- Separate transactions bound dependency locks; do not combine these batches.

DROP TABLE IF EXISTS
  cloud_workspace_engine_instances,
  cloud_workspace_runtime_enrollments,
  cloud_workspace_setup_runs,
  cloud_workspace_runtime_transitions,
  cloud_workspace_setup_specs,
  workspace_settings_versions,
  organization_cloud_policy_versions,
  cloud_workspace_final_save_recoveries,
  workspace_checkpoint_requests,
  cloud_workspace_generation_transitions,
  cloud_workspace_generations,
  cloud_workspace_lifecycle_intents
CASCADE;
