import { z } from "zod";

// Standalone CP mirror of packages/protocol/src/cloud-coordinator.ts.
export const CLOUD_COORDINATOR_FEATURE = "runner.v1";
export const CLOUD_COORDINATOR_HEADER = "x-zeros-cloud-coordinator";
export const CLOUD_COORDINATOR_READINESS_MS = 90_000;
export const CLOUD_COORDINATOR_HEARTBEAT_MS = 60_000;
export const CloudCoordinatorStatusSchema = z.object({
  version: z.literal(1), bootId: z.string().uuid(), revision: z.number().int().positive().safe(),
  frontendId: z.string().uuid().nullable(), ready: z.boolean(),
  expiresAtMs: z.number().int().nonnegative().safe(),
}).strict().refine(value => value.ready ? value.frontendId !== null && value.expiresAtMs > 0 : value.expiresAtMs === 0);
export type CloudCoordinatorStatus = z.infer<typeof CloudCoordinatorStatusSchema>;
