import { z } from "zod";

export const CloudActorRoleSchema = z.enum(["viewer","prompter","developer","manager","owner"]);
export type CloudActorRole = z.infer<typeof CloudActorRoleSchema>;
export type CloudActorContext = {
  sessionId:string;
  deviceId:string;
  role:CloudActorRole;
  fingerprint:string;
};
export const CloudActorContextSchema = z.object({
  sessionId:z.string().uuid(),deviceId:z.string().uuid(),role:CloudActorRoleSchema,
  fingerprint:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const CloudCommandActorSchema=z.object({
  userId:z.string().uuid(),deviceId:z.string().uuid(),deviceKeyVersion:z.number().int().positive().safe(),
  fingerprint:z.string().regex(/^[a-f0-9]{64}$/),role:CloudActorRoleSchema,
}).strict();
export type CloudCommandActor=z.infer<typeof CloudCommandActorSchema>;
export const CloudActorAdmissionResponseSchema = z.object({
  version:z.literal(2),
  audience:z.literal("zeros-cloud-workspace-engine-client-admission-v2"),
  admitted:z.literal(true),
  authorityEpoch:z.number().int().positive().safe(),
  accountUserId:z.string().uuid(),
  actorSessionId:z.string().uuid(),
  deviceId:z.string().uuid(),
  role:CloudActorRoleSchema,
  fingerprint:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Public one-use grant. The engine resolves the bound actor/session itself;
 * clients cannot choose another user's role, device or session metadata. */
export const CloudActorRuntimeGrantSchema = z.object({
  version:z.literal(2),audience:z.literal("zeros-cloud-workspace-engine-client-admission-v2"),
  workspaceId:z.string().uuid(),organizationId:z.string().uuid(),
  generation:z.number().int().positive().safe(),authorityEpoch:z.number().int().positive().safe(),
  engineInstanceId:z.string().uuid(),remotePort:z.number().int().min(1024).max(65535),
  grantToken:z.string().regex(/^zwa_[A-Za-z0-9_-]{43}$/),expiresAt:z.string().datetime(),bridgeUrl:z.string().url(),
}).strict();
export type CloudActorRuntimeGrant = z.infer<typeof CloudActorRuntimeGrantSchema>;

export function sameCloudActor(left:CloudActorContext|undefined,right:CloudActorContext|undefined):boolean {
  return left===right || (!!left && !!right && left.sessionId===right.sessionId && left.deviceId===right.deviceId &&
    left.role===right.role && left.fingerprint===right.fingerprint);
}
export function cloudActorCan(role:CloudActorRole,capability:"read"|"run"|"edit"|"manage"):boolean {
  const rank={viewer:0,prompter:1,developer:2,manager:3,owner:4};
  return Object.hasOwn(rank,role) && rank[role]>={read:0,run:1,edit:2,manage:3}[capability];
}
