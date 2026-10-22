-- zeros-migration: contract
-- zeros-contract-after: 2026-10-21
-- zeros:requires-controlled-downtime
-- Owner-approved cloud v1 retirement, batch 6 of 11; continues 0182.
-- Keep controlled-cutover maintenance until 0200_retire_legacy_cloud_11.sql.
-- Separate transactions bound dependency locks; do not combine these batches.

DROP TABLE IF EXISTS
  workspace_retention_policies,
  workspace_setup_recovery_grants,
  cloud_agent_adoption_keys,
  cloud_agent_credential_controls,
  cloud_agent_execution_leases,
  cloud_agent_history_recoveries,
  cloud_builder_vm_operations,
  cloud_computer_admin_workspaces,
  cloud_computer_templates,
  cloud_runtime_transfer_qualifications,
  cloud_workspace_client_access_grants,
  cloud_workspace_conversation_controls,
  cloud_workspace_directory_outbox,
  cloud_workspace_event_streams,
  cloud_workspace_invitations,
  cloud_workspace_local_command_history_blobs,
  cloud_workspace_local_commands,
  cloud_workspace_owner_delete_receipts,
  cloud_workspace_owner_discard_receipts
CASCADE;
