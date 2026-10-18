import { z } from "zod";
import { RuntimeIdSchema } from "./cloud-runtime-bundle";

export const CLOUD_ENGINE_EXIT_REPORT_ENV = "ZEROS_CLOUD_ENGINE_EXIT_REPORT_B64";
export const CLOUD_ENGINE_EXIT_PATH = "/internal/v1/cloud-workspaces/engine/exited";
/** Declarations use the original S2 feature grammar, including on old CPs. */
export const CLOUD_ENGINE_EXIT_REPORT_FEATURE = "exit.report.v1";
export const CLOUD_CHECKPOINT_FALLBACK_FEATURE = "checkpoint.fallback.v1";
const exitUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
/** Authenticated voluntary withdrawal of this exact VM engine. It grants no
 * access, restart, checkpoint, provider-retirement or billing authority. */
export const CloudEngineExitReportSchema = z.object({
  version: z.literal(1), audience: z.literal("zeros-cloud-engine-exit-v1"),
  reportId: exitUuid, reason: z.literal("unexpected_exit"),
  organizationId: exitUuid, workspaceId: exitUuid, generation: z.number().int().positive().max(2_147_483_647),
  engineInstanceId: exitUuid, setupRunId: exitUuid, executionFence: z.number().int().positive().safe(),
  runtimeId: RuntimeIdSchema, bootId: exitUuid, supervisorSessionId: exitUuid,
}).strict();
export type CloudEngineExitReport = z.infer<typeof CloudEngineExitReportSchema>;

/** Passive receipt of an authorized history gap; never admission authority. */
export const CloudWorkspaceHistoryRecoverySchema = z.object({
  recoveryId: z.string().uuid(), code: z.literal("history_recovered_with_gap"), coverage: z.literal("unknown"),
  generation: z.number().int().positive().safe(), engineInstanceId: z.string().uuid(), bootId: z.string().uuid(),
  writerEpoch: z.string().uuid(), completedAt: z.string().datetime({ offset: true }),
}).strict();
export type CloudWorkspaceHistoryRecovery = z.infer<typeof CloudWorkspaceHistoryRecoverySchema>;

/** Completed restoration is history, separate from active recovery and VM
 * readiness. Older servers omit it; bind it to the exact current generation. */
export const CloudWorkspaceCheckpointRestoreSchema = z.object({
  checkpointId: z.string().uuid(),
  checkpointAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  sourceGeneration: z.number().int().positive().safe(),
  generation: z.number().int().positive().safe(),
}).strict().refine(value => value.generation > value.sourceGeneration);
export type CloudWorkspaceCheckpointRestore = z.infer<typeof CloudWorkspaceCheckpointRestoreSchema>;

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
