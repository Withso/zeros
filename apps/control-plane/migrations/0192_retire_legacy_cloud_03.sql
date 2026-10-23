-- zeros-migration: contract
-- zeros-contract-after: 2026-10-21
-- zeros:requires-controlled-downtime
-- Owner-approved cloud v1 retirement, batch 3 of 11; continues 0182.
-- Keep controlled-cutover maintenance until 0200_retire_legacy_cloud_11.sql.
-- Separate transactions bound dependency locks; do not combine these batches.

DROP TABLE IF EXISTS
  cloud_workspace_initial_delete_captures,
  cloud_workspace_invitation_deliveries,
  cloud_workspace_lifecycle_allocation_waits,
  cloud_workspace_local_agent_controls,
  cloud_workspace_local_command_history_heads,
  cloud_workspace_local_command_history_parts,
  cloud_workspace_local_command_mirror_batches,
  cloud_workspace_members,
  cloud_workspace_metadata_requests,
  cloud_workspace_object_rotation_retry_changes,
  cloud_workspace_object_storage_limit_changes,
  cloud_workspace_object_storage_limits,
  cloud_workspace_outbox,
  cloud_workspace_owner_delete_dispositions,
  cloud_workspace_owner_existing_delete_receipts,
  cloud_workspace_owner_recovery_retries,
  cloud_workspace_ownership_transfers,
  cloud_workspace_paid_authority_checks,
  cloud_workspace_provider_absence_attestations,
  cloud_workspace_provider_bindings,
  cloud_workspace_provider_create_attempts
CASCADE;
