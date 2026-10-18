import { z } from "zod";
import { CapabilityClaimsSchema, CAPABILITY_KEY_ID_PATTERN } from "./capability-contract.js";

/** Mirrored in packages/protocol/src/cloud-capability-sessions.ts. Separate
 * from the N-1 strict admission response, which still requires a bearer. */
export const CAPABILITY_SESSION_ADMISSION_PATH = "/internal/v2/cloud-workspaces/engine/capability-session-admission";
export const CAPABILITY_SESSION_RENEWAL_PATH = "/internal/v2/cloud-workspaces/engine/capability-session-renewal";
export const CAPABILITY_SESSION_AUDIENCE = "zeros-cloud-workspace-capability-session-v1";
const scope = {
  workspaceId: z.string().uuid(), organizationId: z.string().uuid(),
  generation: z.number().int().positive().safe(), engineInstanceId: z.string().uuid(),
};
export const CapabilitySessionAdmissionRequestSchema = z.object({
  ...scope, version: z.literal(1), mode: z.literal("capability-session-v1"),
  capability: z.string().min(32).max(4096).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  proof: z.object({
    timestampMs: z.number().int().nonnegative().safe(), nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  }).strict(),
  route: z.enum(["direct", "relay"]),
}).strict();
export const CapabilitySessionRenewalRequestSchema = CapabilitySessionAdmissionRequestSchema.extend({
  actorSessionId: z.string().uuid(), expectedRevision: z.number().int().positive().safe(),
}).strict();
export const CapabilitySessionResponseSchema = z.object({
  ...scope, version: z.literal(1), audience: z.literal(CAPABILITY_SESSION_AUDIENCE),
  mode: z.literal("capability-session-v1"), admitted: z.literal(true),
  actorSessionId: z.string().uuid(), accountUserId: z.string().uuid(), deviceId: z.string().uuid(),
  authorityEpoch: z.number().int().positive().safe(),
  role: z.enum(["viewer", "prompter", "developer", "manager", "owner"]),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), route: z.enum(["direct", "relay"]),
  capability: z.object({
    claims: CapabilityClaimsSchema, keyId: z.string().regex(CAPABILITY_KEY_ID_PATTERN),
    tokenSha256: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive().safe(),
  }).strict(),
}).strict().superRefine((value, context) => {
  const { claims } = value.capability;
  if (claims.knd !== "client" || claims.aud !== "zeros:engine" || claims.org !== value.organizationId ||
      claims.wsp !== value.workspaceId || claims.gen !== value.generation ||
      (claims.ein !== undefined && claims.ein !== value.engineInstanceId) ||
      claims.sub !== `user:${value.accountUserId}` || claims.did !== value.deviceId ||
      claims.role !== value.role || claims.ep.wa !== value.authorityEpoch)
    context.addIssue({ code: "custom", message: "Capability session binding is inconsistent" });
});
export type CapabilitySessionResponse = z.infer<typeof CapabilitySessionResponseSchema>;
