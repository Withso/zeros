import { z } from "zod";

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
