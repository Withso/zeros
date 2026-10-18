import { z } from "zod";
import { diagnosticPhases, setupEngineStartupSchema } from "./cloud-diagnostics.js";
import { setupTimingsSchema } from "./setup-timings.js";
import { setupObservationsSchema, setupReuseDecisions } from "./setup-observations.js";

// Mirror packages/protocol/src/cloud-setup-evidence.ts. Evidence stays separate
// from the readiness proof and from the immutable stage_timings SQL contract.
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
