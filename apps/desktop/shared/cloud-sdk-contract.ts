import { z } from "zod";
import { CloudAgentBootScopeSchema } from "@zeros/protocol/cloud-agent-bootstrap";

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const positive = z.number().int().positive().safe();
const nonce = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

export const CloudSdkTargetSchema = z.object({ organizationId: uuid, workspaceId: uuid }).strict();
export type CloudSdkTarget = z.infer<typeof CloudSdkTargetSchema>;

const runtimeProof = CloudSdkTargetSchema.extend({ deviceSessionId: uuid, clientSessionId: uuid });
export const CloudSdkDeviceRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("device-session.create"), payload: z.object({ deviceSessionId: uuid.nullable() }).strict() }).strict(),
  z.object({ action: z.literal("runtime.connect"), payload: runtimeProof.extend({
    routes: z.array(z.enum(["direct", "relay"])).min(1).max(2).refine(routes => new Set(routes).size === routes.length),
  }).strict() }).strict(),
  z.object({ action: z.literal("runtime.capabilities"), payload: runtimeProof.strict() }).strict(),
]);

export const CloudSdkCapabilityProofFieldsSchema = z.object({
  aud: z.enum(["zeros:engine", "zeros:realtime"]), wsp: uuid, jti: nonce,
  timestampMs: positive, nonce, route: z.enum(["direct", "relay"]),
}).strict().refine(value => value.aud !== "zeros:realtime" || value.route === "relay");

export const CloudSdkRuntimeIdentitySchema = CloudSdkTargetSchema.extend({
  runtimeId: uuid, generation: positive, authorityEpoch: positive, engineInstanceId: uuid, connectionSequence: positive,
}).strict();
export type CloudSdkRuntimeIdentity = z.infer<typeof CloudSdkRuntimeIdentitySchema>;

export const CloudSdkCapabilitiesSchema = z.object({
  engine: z.object({ token: z.string().min(1).max(4096), expiresAt: z.iso.datetime() }),
  realtime: z.object({ token: z.string().min(1).max(4096), expiresAt: z.iso.datetime() }),
});
export const CloudSdkRuntimeBindingSchema = z.object({ authorityEpoch: positive, bootScope: CloudAgentBootScopeSchema,
  acceptedWorkVersion: z.literal(1).optional() });
export const CloudSdkConnectResponseSchema = z.object({
  workspaceId: uuid, generation: positive, engineInstanceId: uuid.optional(), runtimeBinding: CloudSdkRuntimeBindingSchema.optional(),
  capabilities: CloudSdkCapabilitiesSchema,
  routes: z.array(z.object({ kind: z.enum(["direct", "relay"]), url: z.string().min(1).max(2048), priority: z.number().int().nonnegative().safe() }))
    .min(1).max(2).refine(routes => new Set(routes.map(route => route.kind)).size === routes.length),
  renewAt: z.iso.datetime(), relayHedgeMs: z.number().int().min(300).max(500),
});

/** Desktop-only, native-owned admission. No reusable account bearer or private
 * device key crosses IPC. The connection grants are never persisted. */
export const CloudSdkRuntimeTargetSchema = CloudSdkRuntimeIdentitySchema.extend({
  kind: z.literal("cloud"), channel: z.literal("sdk-websocket"), expiresAt: positive,
  bootScope: CloudAgentBootScopeSchema, deviceSessionId: uuid, clientSessionId: uuid,
  connect: CloudSdkConnectResponseSchema.required({ runtimeBinding: true, engineInstanceId: true }),
}).strict().superRefine((value, context) => {
  const { connect, bootScope } = value;
  if (connect.workspaceId !== value.workspaceId || connect.generation !== value.generation || connect.engineInstanceId !== value.engineInstanceId ||
      connect.runtimeBinding.authorityEpoch !== value.authorityEpoch || bootScope.organizationId !== value.organizationId ||
      bootScope.workspaceId !== value.workspaceId || bootScope.generation !== value.generation || bootScope.engineInstanceId !== value.engineInstanceId ||
      Object.entries(bootScope).some(([key, field]) => connect.runtimeBinding.bootScope[key as keyof typeof bootScope] !== field))
    context.addIssue({ code: "custom", message: "Cloud SDK runtime binding is inconsistent" });
});
export type CloudSdkRuntimeTarget = z.infer<typeof CloudSdkRuntimeTargetSchema>;
export const CloudSdkProofRequestSchema = z.object({ runtime: CloudSdkRuntimeIdentitySchema, fields: CloudSdkCapabilityProofFieldsSchema }).strict();

export const CloudSdkDeviceSessionSchema = z.object({
  deviceSessionId: uuid, contract: z.literal(1), heartbeatIntervalMs: positive,
  stream: z.object({ url: z.string().min(1).max(2048), ticket: z.string().regex(/^zds_[A-Za-z0-9_-]{43}$/), ticketExpiresAt: z.iso.datetime() }),
});
