-- zeros-migration: contract
-- zeros-contract-after: 2026-10-21
-- zeros:requires-controlled-downtime
-- Owner-approved cloud v1 retirement, batch 7 of 11; continues 0182.
-- Keep controlled-cutover maintenance until 0200_retire_legacy_cloud_11.sql.
-- Separate transactions bound dependency locks; do not combine these batches.

DROP TABLE IF EXISTS
  cloud_workspace_provider_operations,
  cloud_workspace_runtime_rollback_refs,
  cloud_workspace_setup_attestations,
  managed_compute_credit_reservations,
  managed_compute_funding_receipts,
  managed_compute_pro_accounts,
  repository_settings_versions,
  workspace_deletion_jobs,
  workspace_record_batches,
  workspace_replicas,
  cloud_agent_credential_delegations,
  cloud_runtime_images,
  cloud_workspace_actor_sessions,
  cloud_workspace_guest_grants,
  cloud_workspace_local_command_controls,
  managed_compute_credit_periods,
  managed_compute_reservation_scopes,
  workspace_record_heads,
  cloud_capability_signing_keys
CASCADE;
