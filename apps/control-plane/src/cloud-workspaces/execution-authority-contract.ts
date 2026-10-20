import { z } from "zod";
import { CloudAgentBootScopeSchema, CloudAgentFundingGrantSchema } from "./agent-boot-contract.js";
import { CloudAcceptedWorkCommandSchema } from "./accepted-work-contract.js";
// Match Zod 4 UUID versions/variants at the independently deployed CP edge.
const uuid = z.string().regex(/^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/);
const scope = CloudAgentBootScopeSchema.extend({ organizationId: uuid, workspaceId: uuid, engineInstanceId: uuid,
  bootId: uuid, writerEpoch: uuid, fundingOwnerUserId: uuid });
const CloudCommandActorSchema = z.object({ userId: uuid, deviceId: uuid,
  deviceKeyVersion: z.number().int().positive().safe(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.enum(["viewer", "prompter", "developer", "manager", "owner"]) }).strict();
const revision = z.number().int().positive().safe();
const timestamp = z.number().int().positive().max(253402300799999);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Engine-authenticated acceptance of one already claimed boot command.
 * This is separate from signed client enrollment and from a context renewal.
 * Neither this request nor its receipt is a bearer or a client credential. */
export const CloudExecutionEnrollRequestSchema = z.object({
  version: z.literal(1), scope,
  runtimeId: z.string().regex(/^r1-[a-f0-9]{64}$/), actorSessionId: uuid,
  contextId: uuid, contextRevision: digest, command: CloudAcceptedWorkCommandSchema.extend({ commandId: uuid }), claimId: uuid,
}).strict();
export type CloudExecutionEnrollRequest = z.infer<typeof CloudExecutionEnrollRequestSchema>;

export const CloudExecutionAuthorityReceiptSchema = CloudExecutionEnrollRequestSchema.extend({
  mode: z.literal("boot-execution-v1"), acceptedWorkId: uuid, revision: z.literal(1),
  actor: CloudCommandActorSchema, fundingGrant: CloudAgentFundingGrantSchema.refine(value =>
    value.kind === "owner" || uuid.safeParse(value.grantId).success),
  sourceSessionId: uuid, epochs: z.object({ wa: revision, wr: revision, me: revision, ac: revision, dk: revision }).strict(),
  credentialId: uuid, credentialRevision: revision,
  acceptedAtMs: timestamp, admissionExpiresAtMs: timestamp,
  providerExpiresAtMs: timestamp, providerProofVersion: revision,
}).strict().superRefine((value, context) => {
  if (value.actor.role === "viewer" || value.actor.deviceKeyVersion !== value.epochs.dk ||
      value.fundingGrant.kind === "owner" && value.actor.userId !== value.scope.fundingOwnerUserId ||
      Math.min(value.admissionExpiresAtMs, value.providerExpiresAtMs) <= value.acceptedAtMs)
    context.addIssue({ code: "custom", message: "Execution acceptance is inconsistent" });
});
export type CloudExecutionAuthorityReceipt = z.infer<typeof CloudExecutionAuthorityReceiptSchema>;

export const CloudExecutionAuthorityOperationSchema = z.object({
  version: z.literal(1), scope, acceptedWorkId: uuid,
  commandId: uuid, claimId: uuid, executionId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
}).strict();
export type CloudExecutionAuthorityOperation = z.infer<typeof CloudExecutionAuthorityOperationSchema>;
export const CloudExecutionAuthorityCheckSchema = z.object({
  version: z.literal(1), acceptedWorkId: uuid, state: z.enum(["current", "revoked"]),
}).strict();
export type CloudExecutionAuthorityCheck = z.infer<typeof CloudExecutionAuthorityCheckSchema>;
