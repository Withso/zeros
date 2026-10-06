import { z } from "zod";

// Mirrored by packages/protocol/src/cloud-runtime-lifecycle.ts (Zod 4).
export const CloudRuntimeUpgradeRequestSchema = z.object({
  expectedGeneration: z.number().int().positive().safe(),
  operationId: z.string().uuid().transform(value => value.toLowerCase()),
}).strict();

export const CloudRuntimeUpgradeAvailabilitySchema = z.object({
  organizationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  currentRuntimeId: z.string().regex(/^r1-[a-f0-9]{64}$/).nullable(),
  latestRuntimeId: z.string().regex(/^r1-[a-f0-9]{64}$/).nullable(),
  updateAvailable: z.boolean(),
  unavailableReason: z.enum([
    "cloud_runtime_upgrade_not_supported", "cloud_runtime_unavailable", "cloud_workspace_busy",
    "cloud_workspace_not_stable", "cloud_generation_transition_active", "cloud_workspace_lifecycle_active",
  ]).nullable(),
  transition: z.object({
    id: z.string().uuid(),
    generation: z.number().int().positive().safe(),
    runtimeId: z.string().regex(/^r1-[a-f0-9]{64}$/),
    state: z.enum(["draining", "provisioning", "setting_up", "rolling_back", "succeeded", "rolled_back", "rollback_failed", "cancelled"]),
    error: z.object({ code: z.string().min(1).max(128), message: z.string().min(1).max(2048) }).strict().nullable(),
  }).strict().nullable(),
}).strict();
export type CloudRuntimeUpgradeAvailability = z.infer<typeof CloudRuntimeUpgradeAvailabilitySchema>;
