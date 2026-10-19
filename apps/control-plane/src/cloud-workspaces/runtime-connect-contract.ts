import { z } from "zod";
import { CloudAgentBootScopeSchema } from "./agent-boot-contract.js";

/** S3 1.4 runtime/connect metadata. The CP deploys independently; the
 * canonical schema and this projection are checked by contract parity tests. */
export const CloudRuntimeBindingSchema = z.object({
  authorityEpoch: z.number().int().positive().safe(),
  bootScope: CloudAgentBootScopeSchema,
  acceptedWorkVersion: z.literal(1).optional(),
}).passthrough();
export type CloudRuntimeBinding = z.infer<typeof CloudRuntimeBindingSchema>;
