import { z } from "zod";
import { CloudRuntimeUpgradeAvailabilitySchema } from "./runtime-upgrade-contract.js";

// Mirrored by packages/protocol/src/cloud-runtime-upgrade-eligibility.ts (Zod 4).
/** Observations only. This route never reserves an update or waives recovery acknowledgement. */
export const CloudRuntimeUpgradeEligibilityRequestSchema = z.object({
  expectedGeneration: z.number().int().positive().safe(),
}).strict();

const recoveryReasons = [
  "generation_changed", "content_changed", "records_changed", "final_checkpoint_unproven",
  "engine_started_after_checkpoint", "setup_completed_after_checkpoint",
] as const;
export const CloudRuntimeUpgradeRecoveryReasonSchema = z.enum(recoveryReasons);
const recovery = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_required_until_stop"), durableAt: z.null(), reasons: z.tuple([]) }).strict(),
  z.object({ state: z.literal("lossless"), durableAt: z.string().datetime({ offset: true }), reasons: z.tuple([]) }).strict(),
  z.object({ state: z.literal("acknowledgement_required"), durableAt: z.string().datetime({ offset: true }),
    reasons: z.array(CloudRuntimeUpgradeRecoveryReasonSchema).min(1).max(recoveryReasons.length) }).strict(),
  z.object({ state: z.literal("unavailable"), durableAt: z.null(), reasons: z.tuple([z.literal("checkpoint_unavailable")]) }).strict(),
]);
export const CloudRuntimeUpgradeDeferredCodeSchema = z.enum([
  "cloud_runtime_upgrade_not_supported", "cloud_runtime_unavailable", "cloud_workspace_busy",
  "cloud_workspace_not_stable", "cloud_generation_changed", "cloud_generation_transition_active",
  "cloud_workspace_lifecycle_active", "cloud_recovery_checkpoint_unavailable",
  "recovery_acknowledgement_required", "cloud_runtime_upgrade_deferred",
]);
export const CloudRuntimeUpgradeEligibilitySchema = z.object({
  version: z.literal(1),
  organizationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  observedAt: z.string().datetime({ offset: true }),
  availability: CloudRuntimeUpgradeAvailabilitySchema,
  recovery,
  lastDeferred: z.object({ generation: z.number().int().positive().safe(),
    at: z.string().datetime({ offset: true }), code: CloudRuntimeUpgradeDeferredCodeSchema }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if (value.availability.organizationId !== value.organizationId ||
      value.availability.workspaceId !== value.workspaceId ||
      value.availability.generation !== value.generation ||
      value.lastDeferred !== null && value.lastDeferred.generation !== value.generation)
    context.addIssue({ code: "custom", message: "Runtime upgrade observation scope is inconsistent" });
  if (value.recovery.state === "acknowledgement_required") {
    const indexes = value.recovery.reasons.map(reason => recoveryReasons.indexOf(reason));
    if (indexes.some((index, offset) => offset > 0 && index <= indexes[offset - 1]!))
      context.addIssue({ code: "custom", message: "Recovery reasons must be unique and ordered" });
  }
});
export type CloudRuntimeUpgradeEligibility = z.infer<typeof CloudRuntimeUpgradeEligibilitySchema>;
export type CloudRuntimeUpgradeRecoveryReason = z.infer<typeof CloudRuntimeUpgradeRecoveryReasonSchema>;

