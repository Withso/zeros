import { z } from "zod";

// Mirrored by packages/protocol/src/cloud-runtime-lifecycle.ts (Zod 4).
export const CloudRuntimeUpgradeRequestSchema = z.object({
  expectedGeneration: z.number().int().positive().safe(),
  operationId: z.string().uuid().transform(value => value.toLowerCase()),
}).strict();
