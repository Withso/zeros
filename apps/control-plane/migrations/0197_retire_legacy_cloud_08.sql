-- zeros-migration: contract
-- zeros-contract-after: 2026-10-21
-- zeros:requires-controlled-downtime
-- Owner-approved cloud v1 retirement, batch 8 of 11; continues 0182.
-- Keep controlled-cutover maintenance until 0200_retire_legacy_cloud_11.sql.
-- Separate transactions bound dependency locks; do not combine these batches.

DROP TABLE IF EXISTS
  managed_compute_credit_accounts,
  managed_compute_user_periods,
  managed_compute_user_accounts,
  cloud_agent_boot_bindings,
  cloud_workspace_local_command_writers,
  cloud_computer_builds,
  cloud_computer_images,
  cloud_computer_v2_builds,
  cloud_computer_v2_heads,
  cloud_computer_v2_configs,
  cloud_computers,
  cloud_runtime_base_contracts,
  cloud_runtime_base_images,
  cloud_runtime_bundles,
  cloud_workspace_allocation_owners,
  managed_compute_allocation_leases,
  cloud_workspace_endpoint_grants,
  devices
CASCADE;
