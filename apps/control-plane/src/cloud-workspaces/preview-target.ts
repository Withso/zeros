import { z } from "zod";

/** Independently deployed mirror of protocol/containment's opaque native
 * preview identity. CP never interprets this as listener coordinates. */
export const CloudAgentPreviewTargetSchema = z
  .object({
    executionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    portId: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  })
  .strict();
export type CloudAgentPreviewTarget = z.infer<
  typeof CloudAgentPreviewTargetSchema
>;
export function isCloudAgentPreviewTarget(
  value: unknown,
): value is CloudAgentPreviewTarget {
  return CloudAgentPreviewTargetSchema.safeParse(value).success;
}
