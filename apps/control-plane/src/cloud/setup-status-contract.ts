// Standalone mirror of protocol/cloud-v2-relay; acceptance is tested.
import { z } from "zod";

export const CLOUD_V2_SETUP_STATES = ["running", "succeeded", "failed", "interrupted"] as const;
export const CloudV2SetupStatusSchema = z.object({
  state: z.enum(CLOUD_V2_SETUP_STATES),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().optional(),
  reason: z.enum(["timed_out", "script_refused", "source_changed"]).optional(),
}).strict();
export type CloudV2SetupStatus = z.infer<typeof CloudV2SetupStatusSchema>;

/** workspace-repositories-v1: a repository after the first of a workspace of several reports its own setup. */
export const CloudV2RepositorySetupStatusSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/),
  status: CloudV2SetupStatusSchema,
}).strict();
