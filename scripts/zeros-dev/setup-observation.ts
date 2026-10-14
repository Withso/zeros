import { z } from "zod";

// The CLI never forwards arbitrary server diagnostic strings, even when the
// server promises redaction. New codes remain unknown until reviewed here.
const SetupErrorSchema = z.enum([
  "setup_image_contract_invalid", "setup_helper_failed", "setup_provider_failure",
  "setup_provider_bootstrap_unavailable", "setup_admission_unavailable", "setup_engine_readiness_failed",
  "setup_checkpoint_restore_invalid", "setup_checkpoint_restore_unavailable", "setup_repository_revision_invalid",
  "setup_repository_history_limit", "setup_repository_unavailable", "setup_command_failed", "setup_request_invalid",
  "setup_settings_invalid", "setup_execution_aborted", "setup_readiness_invalid", "setup_helper_response_invalid",
  "setup_helper_response_truncated", "setup_helper_secret_echo", "setup_admission_invalid", "setup_admission_revoke_failed",
  "setup_runtime_install_failed", "setup_runtime_input_invalid", "engine_unavailable", "engine_lease_expired",
  "compute_reconciliation_failed", "unknown",
]);
export const SetupObservationSchema = z.object({
  attempt: z.number().int().positive().safe(), claimCount: z.number().int().nonnegative().safe(),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  errorCode: SetupErrorSchema.nullable(),
}).strict();
export type SetupObservation = z.infer<typeof SetupObservationSchema>;

const ProgressSchema = SetupObservationSchema.extend({
  generation: z.number().int().positive().safe(), errorCode: z.unknown(),
});
export function readSetupProgress(value: unknown, generation: number): SetupObservation | undefined {
  const parsed = ProgressSchema.safeParse(value);
  if (!parsed.success || parsed.data.generation !== generation) return undefined;
  const { attempt, claimCount, state, errorCode } = parsed.data;
  return { attempt, claimCount, state,
    errorCode: errorCode === null ? null : SetupErrorSchema.safeParse(errorCode).data ?? "unknown" };
}
