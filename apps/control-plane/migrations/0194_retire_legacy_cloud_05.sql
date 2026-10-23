-- zeros-migration: contract
-- zeros-contract-after: 2026-10-21
-- zeros:requires-controlled-downtime
-- Owner-approved cloud v1 retirement, batch 5 of 11; continues 0182.
-- Keep controlled-cutover maintenance until 0200_retire_legacy_cloud_11.sql.
-- Separate transactions bound dependency locks; do not combine these batches.

DROP TABLE IF EXISTS
  managed_compute_staff_allowance_receipts,
  managed_compute_usage_disagreements,
  organization_cloud_policy_heads,
  personal_profile_inheritance_consents,
  port_forward_sessions,
  repository_settings_heads,
  workspace_blob_object_deletions,
  workspace_blob_references,
  workspace_blob_rotation_jobs,
  workspace_blob_storage_reservations,
  workspace_checkpoint_entries,
  workspace_deletion_blob_targets,
  workspace_executions,
  workspace_export_grants,
  workspace_file_entries,
  workspace_file_events,
  workspace_fork_import_entries,
  workspace_fork_import_records,
  workspace_ports,
  workspace_record_entities,
  workspace_record_events,
  workspace_replica_commands,
  workspace_replica_events,
  workspace_replica_grants,
  workspace_replica_receipts
CASCADE;
