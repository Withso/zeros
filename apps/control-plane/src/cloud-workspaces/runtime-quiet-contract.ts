import { z } from "zod";

/** Standalone mirror of protocol/cloud-runtime-lifecycle; parity tested. */
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
export type CloudRuntimeQuietScope = Pick<CloudRuntimeQuietSnapshot, "workspaceId" | "organizationId" | "generation" | "engineInstanceId">;
