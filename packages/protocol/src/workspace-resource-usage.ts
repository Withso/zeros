import { z } from "zod";

export const WORKSPACE_RESOURCE_USAGE_CAPABILITY = "workspace.resourceUsage.v1";
export const WorkspaceResourceUsageIdentitySchema = z.object({
  organizationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  engineInstanceId: z.string().uuid(),
}).strict();
export type WorkspaceResourceUsageIdentity = z.infer<typeof WorkspaceResourceUsageIdentitySchema>;

const percentage = z.number().finite().min(0).max(100).nullable();
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const capacity = z.object({
  totalBytes: bytes, availableBytes: bytes, usedBytes: bytes, usedPercent: percentage,
}).strict().refine(value => {
  const { totalBytes, availableBytes, usedBytes, usedPercent } = value;
  if (totalBytes === null || availableBytes === null || usedBytes === null || usedPercent === null)
    return totalBytes === null && availableBytes === null && usedBytes === null && usedPercent === null;
  return totalBytes > 0 && availableBytes <= totalBytes && usedBytes === totalBytes - availableBytes &&
    Math.abs(usedPercent - usedBytes / totalBytes * 100) < 0.000001;
}, "Resource capacity and percentage must share a denominator");

/** Small, path-free VM observations. Allocation/billing totals are separate
 * metadata; each utilization denominator comes from the sampled resource. */
export const WorkspaceResourceUsageSchema = WorkspaceResourceUsageIdentitySchema.extend({
  version: z.literal(1),
  sampledAt: z.string().datetime(),
  cpu: z.object({
    cores: z.number().int().positive().max(4096).nullable(),
    usedPercent: percentage,
  }).strict().refine(value => value.cores !== null || value.usedPercent === null),
  memory: capacity,
  disk: capacity,
}).strict();
export type WorkspaceResourceUsage = z.infer<typeof WorkspaceResourceUsageSchema>;
