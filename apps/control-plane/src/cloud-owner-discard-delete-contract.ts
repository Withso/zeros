import { createHash } from "node:crypto";
import { z } from "zod";
import { parseDatabaseTarget } from "./database-target.js";
import { BOAT_RESOURCE_ID_PATTERN } from "./cloud-workspaces/boat-client.js";
import { canonicalFinalSaveJson } from "./cloud-workspaces/final-save-contract.js";

const uuid = z.string().uuid().transform(value => value.toLowerCase());

/** Private operator input. Acknowledging all data loss is neither a saved
 * checkpoint nor evidence that the provider has already deleted anything. */
export const CloudOwnerDiscardDeleteSchema = z.object({
  version: z.literal(1),
  channel: z.enum(["development", "alpha"]),
  operationId: uuid,
  organizationId: uuid,
  expectedOrganizationSlug: z.string().trim().min(1).max(255).transform(value => value.toLowerCase()),
  workspaceId: uuid,
  ownerUserId: uuid,
  operatorUserId: uuid,
  sourceGeneration: z.number().int().positive().safe(),
  stopIntentId: uuid,
  requestId: uuid,
  engineInstanceId: uuid,
  allocationLeaseId: uuid,
  providerResourceId: z.string().regex(BOAT_RESOURCE_ID_PATTERN),
  providerAccountScope: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  ownerAcknowledgedCompleteDataLoss: z.literal(true),
  ownerApprovalReference: z.string().trim().min(16).max(512),
  reason: z.string().trim().min(16).max(512),
}).strict();
export type CloudOwnerDiscardDeleteRequest = z.infer<typeof CloudOwnerDiscardDeleteSchema>;

export const ownerDeleteDigest = (value: unknown): Buffer =>
  createHash("sha256").update(canonicalFinalSaveJson(value)).digest();

export function ownerDeleteTarget(databaseUrl: string, channel: string): string {
  const target = parseDatabaseTarget(databaseUrl);
  return ownerDeleteDigest(["cloud-owner-discard-delete/v1", channel, target.hostname,
    target.port, target.pathname, decodeURIComponent(target.username)]).toString("hex");
}

export class CloudOwnerDiscardDeleteError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CloudOwnerDiscardDeleteError"; }
}
export function requireOwnerDelete(condition: unknown, code: string): asserts condition {
  if (!condition) throw new CloudOwnerDiscardDeleteError(code);
}
