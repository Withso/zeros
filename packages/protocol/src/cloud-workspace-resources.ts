import { z } from "zod";

/** WORKSPACE_REQUEST `workspace.resources`, answered only by a cloud worker
 * that advertises this ENGINE_READY capability. Sampled on request. */
export const CLOUD_WORKSPACE_RESOURCES_CAPABILITY = "workspace-resources-v1";

const percent = z.number().min(0).max(100);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const CloudWorkspaceResourcesSchema = z.object({
  cpu: z.object({ cores: z.number().int().min(1).max(4096), usedPercent: percent }).strict(),
  memory: z.object({ totalBytes: bytes, usedPercent: percent }).strict(),
  disk: z.object({ totalBytes: bytes, usedPercent: percent }).strict(),
  sampledAt: z.number().int().nonnegative(),
}).strict();
export type CloudWorkspaceResources = z.infer<typeof CloudWorkspaceResourcesSchema>;
