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
