import { z } from "zod";
import { RuntimeIdSchema } from "./cloud-runtime-bundle";

/** Staff-only explicit upgrade. The server retains the source base and pins
 * the selected runtime once; operationId replays that accepted selection. */
export const CloudRuntimeUpgradeRequestSchema = z.object({
  expectedGeneration: z.number().int().positive().safe(),
  operationId: z.string().uuid().transform(value => value.toLowerCase()),
}).strict();

export const CloudRuntimeUpgradeResponseSchema = z.object({
  operationId: z.string().uuid(),
  sourceGeneration: z.number().int().positive().safe(),
  generation: z.number().int().positive().safe(),
  runtimeId: RuntimeIdSchema,
  transitionId: z.string().uuid().nullable(),
  unchanged: z.boolean(),
}).strict();

export type CloudRuntimeUpgradeRequest = z.infer<typeof CloudRuntimeUpgradeRequestSchema>;
export type CloudRuntimeUpgradeResponse = z.infer<typeof CloudRuntimeUpgradeResponseSchema>;

/** Read-only staff discovery and the latest explicit upgrade's progress. */
export const CloudRuntimeUpgradeAvailabilitySchema = z.object({
  organizationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  currentRuntimeId: RuntimeIdSchema.nullable(),
  latestRuntimeId: RuntimeIdSchema.nullable(),
  updateAvailable: z.boolean(),
  unavailableReason: z.enum([
    "cloud_runtime_upgrade_not_supported", "cloud_runtime_unavailable", "cloud_workspace_busy",
    "cloud_workspace_not_stable", "cloud_generation_transition_active", "cloud_workspace_lifecycle_active",
  ]).nullable(),
  transition: z.object({
    id: z.string().uuid(),
    generation: z.number().int().positive().safe(),
    runtimeId: RuntimeIdSchema,
    state: z.enum(["draining", "provisioning", "setting_up", "rolling_back", "succeeded", "rolled_back", "rollback_failed", "cancelled"]),
    error: z.object({ code: z.string().min(1).max(128), message: z.string().min(1).max(2048) }).strict().nullable(),
  }).strict().nullable(),
}).strict();
export type CloudRuntimeUpgradeAvailability = z.infer<typeof CloudRuntimeUpgradeAvailabilitySchema>;

/** Read-only, nonce-bound evidence for the trusted runtime controller. It is
 * an observation, never a reservation or permission to interrupt work. */
export const CloudRuntimeQuietSnapshotSchema = z.object({
  version: z.literal(1),
  challenge: z.string().uuid(),
  workspaceId: z.string().uuid(),
  organizationId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  engineInstanceId: z.string().uuid(),
  activityRevision: z.number().int().nonnegative().safe(),
  quietForMs: z.number().int().nonnegative().safe(),
  stable: z.boolean(),
  recordSync: z.enum(["ready", "pending", "failed"]),
  workloadBusy: z.boolean(),
  livePty: z.boolean(),
  userProcesses: z.enum(["idle", "busy", "unknown"]),
  presence: z.enum(["present", "absent", "unknown"]),
}).strict();
export type CloudRuntimeQuietSnapshot = z.infer<typeof CloudRuntimeQuietSnapshotSchema>;
