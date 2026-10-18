import { z } from "zod";
import { setupTimingsSchema } from "./cloud-runtime-bundle";

// Mirrors the standalone control-plane setup evidence and helper observations.
// These are measurements, never readiness or launch authority.

// Closed observations only. None of these labels authorizes preparation,
// launch, readiness or reuse. Mirror the helper and protocol contracts.
export const setupReuseDecisions = ["disabled", "not_negotiated", "ineligible", "no_completed_epoch", "candidate", "changed_during_redemption"] as const;
export const setupPreparationOutcomes = ["plan_unavailable", "prepare_generation", "record_unavailable", "record_invalid",
  "key_changed", "epoch_changed", "repository_incomplete", "settings_changed", "repository_changed", "reused"] as const;
export const setupReadinessObservations = ["ready", "transport_error", "http_error", "invalid_response", "not_ready"] as const;
export const setupObservationsSchema = z.object({ version: z.literal(1),
  preparation: z.enum(setupPreparationOutcomes).optional(), readiness: z.enum(setupReadinessObservations).optional(),
}).strict();
export type SetupObservations = z.infer<typeof setupObservationsSchema>;
export function parseSetupObservations(value: unknown): SetupObservations | undefined {
  const parsed = setupObservationsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export const diagnosticPhases = ["provider_inspect", "meter_read", "ledger_commit", "authority_check", "provider_renew", "final_settlement",
  "setup_admission", "bootstrap", "runtime", "supervisor", "image_preflight", "repository", "credential_projection", "image_launch", "engine_launch", "engine_readiness"] as const;
const bootFailureCategories = [
  "rejected", "authority_unavailable", "authority_timeout", "authority_transport", "authority_http_4xx", "authority_http_5xx",
  "authority_response_invalid", "canary_failed", "attestation_failed", "timeout", "auth_required", "verification_required",
  "cloud_credential_error", "subprocess_exited", "protocol_error", "transport_closed", "lifecycle_superseded", "rate_limited",
  "design_protection_failed", "session_expired",
  "executor_start_failed", "provider_login_failed", "environment_setup_failed", "environment_identity_mismatch", "environment_not_ready",
  "credential_refresh_invalid", "credential_refresh_timeout", "credential_refresh_unchanged", "credential_refresh_rejected", "lock_busy", "execution_limit",
  "customization_changed", "access_denied", "environment_revoked", "environment_runtime_required", "environment_unavailable", "lease_expired",
] as const;
const checkpointFailureCodes = [
  "checkpoint_directory_metadata", "checkpoint_file_open_flags", "checkpoint_file_metadata", "checkpoint_part_path",
  "checkpoint_inventory_timeout", "checkpoint_seal_missing", "checkpoint_seal_document", "checkpoint_seal_ack",
  "checkpoint_writer_scope", "checkpoint_writer_unsealed", "checkpoint_journal_head", "checkpoint_mirror_head",
  "checkpoint_inventory_hash", "checkpoint_stream_head", "checkpoint_pending_work", "checkpoint_normal_head",
  "checkpoint_capture_read", "checkpoint_capture_identity", "checkpoint_manifest_size", "checkpoint_manifest_missing",
  "checkpoint_manifest_identity", "checkpoint_manifest_invalid", "checkpoint_workspace_mismatch", "checkpoint_expected_writer_mismatch",
  "checkpoint_part_missing", "checkpoint_part_size", "checkpoint_part_hash", "checkpoint_part_identity",
  "checkpoint_assembled_size", "checkpoint_assembled_hash", "checkpoint_restore_read", "checkpoint_restore_hash", "checkpoint_restore_identity",
] as const;
export const setupEngineStartupSchema = z.object({
  phase: z.enum(["startup", "registration", "history_restore", "boot_owner",
    "boot_bootstrap", "boot_credentials", "boot_durability", "boot_activate", "boot_install"]),
  name: z.enum(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "ZodError", "SqliteError",
    "CloudCommandRuntimeError", "CloudRuntimeRequestError", "CloudAgentExecutionError", "CloudAgentAdmissionError",
    "CloudRuntimeUpgradeRequiredError", "CloudCredentialControlError", "unknown"]),
  code: z.enum(["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "EDQUOT", "EMFILE", "ENFILE",
    "EEXIST", "ELOOP", "EBUSY", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET",
    "SQLITE_CORRUPT", "SQLITE_NOTADB", "SQLITE_CANTOPEN", "SQLITE_BUSY", "SQLITE_IOERR", "SQLITE_READONLY", "SQLITE_FULL",
    "command_storage_unavailable", "command_conflict", "cloud_command_writer_retired", "engine_authority_rejected",
    "cloud_commands_unavailable", "cloud_actor_authority_rejected", "cloud_runtime_upgrade_required", "unknown",
    "cloud_workspace_client_update_required", "cloud_workspace_v2_required", "cloud_agent_model_not_authorized",
    "cloud_agent_credential_required", "cloud_agent_credential_expired", "cloud_agent_credential_revoked", "cloud_agent_credential_refresh_required",
    "credential_control_authority_rejected", "credential_control_conflict", "credential_control_limit",
    "credential_control_storage_unavailable", "credential_control_invalid",
    ...checkpointFailureCodes,
    ...(["admission", "validation"] as const).flatMap(stage => bootFailureCategories.map(category => `cloud_${stage}_${category}` as const))]),
  errno: z.number().int().refine(value => [-1, -2, -5, -13, -16, -17, -20, -21, -23, -24, -28, -30, -40, -104, -110, -111, -122].includes(value)).nullable(),
}).strict();

export const setupErrorCodes = [
  "setup_image_contract_invalid", "setup_helper_failed", "setup_provider_failure",
  "setup_provider_bootstrap_unavailable", "setup_provider_bootstrap_cleanup_unconfirmed", "setup_admission_unavailable", "setup_engine_readiness_failed",
  "setup_checkpoint_restore_invalid", "setup_checkpoint_restore_unavailable", "setup_repository_revision_invalid",
  "setup_repository_history_limit", "setup_repository_unavailable", "setup_command_failed", "setup_request_invalid",
  "setup_settings_invalid", "setup_execution_aborted", "setup_readiness_invalid", "setup_helper_response_invalid",
  "setup_helper_response_truncated", "setup_helper_secret_echo", "setup_admission_invalid", "setup_admission_revoke_failed",
  "setup_runtime_install_failed", "setup_runtime_input_invalid", "engine_unavailable", "engine_lease_expired",
  "setup_unknown_failure", "setup_executor_failure", "setup_timed_out", "setup_heartbeat_failed", "setup_lease_lost", "setup_worker_stopped",
  "setup_publish_ineligible", "setup_hook_retry_required", "compute_reconciliation_failed", "unknown",
] as const;
export const setupFailureSchema = z.object({ code: z.enum(setupErrorCodes), phase: z.enum(diagnosticPhases), retryable: z.boolean(),
  engineStartup: setupEngineStartupSchema.optional(),
}).strict();
const positive = z.number().int().positive().safe();
const timestamp = z.string().datetime({ precision: 3 }).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
export const setupClaimSchema = z.object({
  executionFence: positive, claimCount: positive, outcome: z.enum(["started", "succeeded", "failed", "cancelled"]),
  startedAt: timestamp.nullable(), completedAt: timestamp.nullable(),
  reuseDecision: z.enum(setupReuseDecisions).optional(), observations: setupObservationsSchema.optional(),
  timings: setupTimingsSchema.optional(), failure: setupFailureSchema.optional(),
  engine: z.object({ id: z.string().uuid(), createdAt: timestamp, registeredAt: timestamp.nullable() }).strict().optional(),
}).strict();
export type SetupClaim = z.infer<typeof setupClaimSchema>;
export const setupEvidenceSchema = z.object({
  version: z.literal(1), workspaceId: z.string().uuid(), generation: positive, setupRunId: z.string().uuid(),
  attempt: positive, claimCount: z.number().int().nonnegative().safe(), executionFence: z.number().int().nonnegative().safe(),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]), runtimeId: z.string().regex(/^r1-[a-f0-9]{64}$/).nullable(),
  createdAt: timestamp, startedAt: timestamp.nullable(), completedAt: timestamp.nullable(),
  claims: z.array(setupClaimSchema).max(5), truncated: z.boolean(),
}).strict().refine(value => value.claims.every((claim, index) => claim.executionFence <= value.executionFence &&
  claim.claimCount <= value.claimCount && (!index || claim.executionFence > value.claims[index - 1]!.executionFence)) &&
  Buffer.byteLength(JSON.stringify(value)) <= 49_152);
export type SetupEvidence = z.infer<typeof setupEvidenceSchema>;
