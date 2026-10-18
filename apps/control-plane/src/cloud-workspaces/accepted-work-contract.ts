import { z } from "zod";
import { CloudAgentBootScopeSchema } from "./agent-boot-contract.js";
const CloudCommandActorSchema = z.object({ userId: z.string().uuid(), deviceId: z.string().uuid(),
  deviceKeyVersion: z.number().int().positive().safe(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.enum(["viewer", "prompter", "developer", "manager", "owner"]) }).strict();

/** Engine-only accepted-work v1. A receipt is an identifier and immutable
 * evidence, never a bearer credential or a generic actor/grant. */
const revision = z.number().int().positive().safe();
const timestamp = z.number().int().positive().max(253402300799999);
const identity = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const runtime = z.string().regex(/^r1-[a-f0-9]{64}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const scopes = z.array(z.enum(["ws:read", "ws:prompt", "ws:edit", "ws:manage"])).min(1).max(4)
  .refine(values => new Set(values).size === values.length && values.includes("ws:prompt"));

export const CloudAcceptedWorkCommandSchema = z.object({
  commandId: z.string().uuid(), conversationId: identity, turnId: identity, executionId: identity,
  payloadSha256: sha256, provider: z.enum(["claude", "codex", "cursor"]), model: z.string().min(1).max(256),
  cwd: z.string().min(1).max(4096).refine(value => value.startsWith("/") && !/[\x00-\x1f\x7f]/.test(value)),
}).strict();
export type CloudAcceptedWorkCommand = z.infer<typeof CloudAcceptedWorkCommandSchema>;

export const CloudAcceptedWorkEnrollRequestSchema = z.object({
  version: z.literal(1), scope: CloudAgentBootScopeSchema, runtimeId: runtime,
  actorSessionId: z.string().uuid(), command: CloudAcceptedWorkCommandSchema,
  capability: z.string().min(32).max(4096).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  proof: z.object({ timestampMs: z.number().int().nonnegative().safe(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict(),
  route: z.enum(["direct", "relay"]),
}).strict();
export type CloudAcceptedWorkEnrollRequest = z.infer<typeof CloudAcceptedWorkEnrollRequestSchema>;

export const CloudAcceptedWorkReceiptSchema = z.object({
  version: z.literal(1), acceptedWorkId: z.string().uuid(), revision: z.literal(1),
  scope: CloudAgentBootScopeSchema, runtimeId: runtime, actorSessionId: z.string().uuid(),
  actor: CloudCommandActorSchema, sourceSessionId: z.string().uuid(),
  kid: z.string().regex(/^cap-[0-9]{4}-[0-9]{2}-[a-z0-9]{1,16}$/),
  capabilityId: z.string().min(16).max(128), devicePublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  epochs: z.object({ wa: revision, wr: revision, me: revision, ac: revision, dk: revision }).strict(),
  scopes, command: CloudAcceptedWorkCommandSchema,
  acceptedAtMs: timestamp, capabilityExpiresAtMs: timestamp, providerExpiresAtMs: timestamp, providerProofVersion: revision,
}).strict().superRefine((value, context) => {
  if (value.actor.role !== "owner" || value.actor.userId !== value.scope.fundingOwnerUserId || value.actor.deviceKeyVersion !== value.epochs.dk ||
      value.capabilityExpiresAtMs <= value.acceptedAtMs || value.providerExpiresAtMs <= value.acceptedAtMs)
    context.addIssue({ code: "custom", message: "Accepted work authority is inconsistent" });
});
export type CloudAcceptedWorkReceipt = z.infer<typeof CloudAcceptedWorkReceiptSchema>;

/** Exact execution consumers only. This envelope cannot select another
 * account, repository, command, credential or workspace operation. */
export const CloudAcceptedWorkOperationSchema = z.object({
  version: z.literal(1), acceptedWorkId: z.string().uuid(), scope: CloudAgentBootScopeSchema,
  runtimeId: runtime, command: CloudAcceptedWorkCommandSchema,
  operation: z.enum(["context", "native-git"]),
}).strict();
export type CloudAcceptedWorkOperation = z.infer<typeof CloudAcceptedWorkOperationSchema>;
