import { z } from "zod";

export const MAX_PENDING_WORKSPACES = 8;
export const FIXTURE_STORAGE_MIB = 70_225;
export const MAX_PENDING_STORAGE_MIB = MAX_PENDING_WORKSPACES * FIXTURE_STORAGE_MIB;
export const MAX_PENDING_AGE_MS = 8 * 60 * 60_000;
export const MAX_CARRIED_RUNS = MAX_PENDING_WORKSPACES + 1;
export const RETIREMENT_FRESH_MS = 60_000;

const nonnegative = z.number().int().nonnegative().safe();
export { CloudWorkspaceDeletionRetirementSchema as DeletionRetirementSchema } from "./deletion-retirement-contract";
export type { CloudWorkspaceDeletionRetirement as DeletionRetirement } from "./deletion-retirement-contract";

export const CleanupHandoffReferenceSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/),
  runIds: z.array(z.string().uuid()).min(1).max(4).refine(ids => new Set(ids).size === ids.length) }).strict();
export type CleanupHandoffReference = z.infer<typeof CleanupHandoffReferenceSchema>;

export const CleanupSummarySchema = z.object({
  outcome: z.enum(["none", "physically_deleted", "compute_retired_storage_pending", "unconfirmed"]),
  deletionConfirmed: z.boolean(), pendingWorkspaces: nonnegative, pendingGenerations: nonnegative,
  reservedStorageMiB: nonnegative, oldestRequestedAt: z.string().datetime().nullable(),
  unconfirmedWorkspaces: nonnegative, reservationCoverage: z.enum(["complete", "unavailable"]),
}).strict();
export type CleanupSummary = z.infer<typeof CleanupSummarySchema>;
