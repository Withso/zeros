import { createHash } from "node:crypto";
import { z } from "zod";
import { parseDatabaseTarget } from "./database-target.js";
import { BOAT_RESOURCE_ID_PATTERN } from "./cloud-workspaces/boat-client.js";
import { canonicalFinalSaveJson } from "./cloud-workspaces/final-save-contract.js";

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive().safe();

/** Private operator input, never a renderer/engine API. The owner explicitly
 * acknowledges the named checkpoint and all newer unsaved work. */
export const CloudOwnerCheckpointRecoverySchema = z.object({
  version: z.literal(1),
  operationId: uuid,
  channel: z.enum(["development", "alpha"]),
  organizationId: uuid,
  expectedOrganizationSlug: z.string().trim().min(1).max(255).transform(value => value.toLowerCase()),
  workspaceId: uuid,
  ownerUserId: uuid,
  operatorUserId: uuid,
  sourceGeneration: revision,
  stopIntentId: uuid,
  wakeIntentId: uuid,
  recoveryId: uuid,
  requestId: uuid,
  retirementId: uuid,
  custodyId: uuid,
  providerResourceId: z.string().regex(BOAT_RESOURCE_ID_PATTERN),
  providerAccountScope: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  providerLossAttestationId: uuid,
  checkpointId: uuid,
  checkpointSha256: sha256,
  checkpointContentRevision: revision,
  checkpointRecordRevision: z.number().int().nonnegative().safe(),
  checkpointAt: z.string().datetime({ offset: true }),
  computerBuildId: uuid,
  computerConfigId: uuid,
  runtimeId: z.string().regex(/^r1-[a-f0-9]{64}$/),
  ownerAcknowledgedUnsavedLoss: z.literal(true),
  ownerApprovalReference: z.string().trim().min(16).max(512),
  reason: z.string().trim().min(16).max(512),
}).strict().refine(value => value.stopIntentId === value.recoveryId && value.stopIntentId !== value.wakeIntentId,
  { message: "The exact Stop recovery and dependent Wake are required" });

export type CloudOwnerCheckpointRecoveryRequest = z.infer<typeof CloudOwnerCheckpointRecoverySchema>;

export const ownerRecoveryDigest = (value: unknown): Buffer =>
  createHash("sha256").update(canonicalFinalSaveJson(value)).digest();

export function ownerRecoveryTarget(databaseUrl: string, channel: string): string {
  const url = parseDatabaseTarget(databaseUrl);
  return ownerRecoveryDigest(["cloud-owner-checkpoint-recovery/v1", channel,
    url.hostname, url.port, url.pathname, decodeURIComponent(url.username)]).toString("hex");
}

export class CloudOwnerCheckpointRecoveryError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CloudOwnerCheckpointRecoveryError"; }
}

export function requireOwnerRecovery(condition: unknown, code: string): asserts condition {
  if (!condition) throw new CloudOwnerCheckpointRecoveryError(code);
}
