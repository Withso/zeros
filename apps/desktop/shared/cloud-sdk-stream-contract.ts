import { z } from "zod";
import { CloudWorkspaceDocumentSchema } from "../src/renderer/platform/cloud-workspace-contract";
import { CloudSdkCapabilitiesSchema, CloudSdkRuntimeIdentitySchema, CloudSdkTargetSchema } from "./cloud-sdk-contract";

const uuid = z.string().uuid();
const version = z.number().int().nonnegative().safe();
const code = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/);
const cursor = z.string().min(1).max(256);
const feature = z.object({ organizationId: uuid, deviceStream: z.boolean(), presence: z.boolean() })
  .refine(value => !value.presence || value.deviceStream);
const features = z.array(feature).max(1_000).refine(rows => new Set(rows.map(row => row.organizationId)).size === rows.length);
const presence = z.enum(["active", "idle", "away"]);
const handle = z.object({ streamId: uuid, leaseId: uuid }).strict();
const start = z.object({ action: z.literal("start"), target: CloudSdkTargetSchema }).strict();
export const CloudSdkStreamCommandSchema = z.discriminatedUnion("action", [
  start,
  handle.extend({ action: z.literal("stop") }).strict(),
  handle.extend({ action: z.literal("snapshot-current"), revision: version, catalogVersion: version.nullable(),
    workspaces: z.array(CloudSdkTargetSchema.extend({ version }).strict()).max(1_000),
  }).strict(),
  handle.extend({ action: z.literal("presence"), runtime: CloudSdkRuntimeIdentitySchema, state: presence }).strict(),
]);
export type CloudSdkStreamCommand = z.infer<typeof CloudSdkStreamCommandSchema>;

const catalog = z.object({ t: z.literal("catalog.changed"), c: cursor, d: z.object({
  workspaceId: uuid, version, catalogVersion: version, op: z.enum(["upsert", "remove"]), workspace: CloudWorkspaceDocumentSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.op === "upsert" && (!value.workspace || value.workspace.id !== value.workspaceId || value.workspace.version !== value.version))
    ctx.addIssue({ code: "custom", message: "Catalog document identity is inconsistent" });
}) });
const lifecycle = z.object({ t: z.literal("lifecycle.changed"), c: cursor, d: z.object({
  workspaceId: uuid, version, status: z.string().min(1).max(64), generation: z.number().int().positive().safe(),
  observedState: z.string().min(1).max(64), reason: code.optional(),
}) });
const members = z.object({ t: z.literal("presence.changed"), d: z.object({ workspaceId: uuid,
  members: z.array(z.object({ userId: uuid, state: presence, since: z.iso.datetime() })).max(256),
}) });
const notification = z.object({ t: z.literal("notification"), c: cursor, d: z.object({ id: uuid,
  kind: z.enum(["turn.completed", "turn.failed", "turn.needs_attention", "workspace.stopped", "workspace.funds_low"]),
  workspaceId: uuid, chatId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(), turnId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  title: z.string().min(1).max(200), createdAt: z.iso.datetime(),
}) });
const revoked = z.object({ t: z.literal("capability.revoked"), c: cursor, d: z.object({
  workspaceId: uuid.optional(), reason: code, scope: z.enum(["workspace", "account", "session", "device", "organization"]),
}).refine(value => value.scope !== "workspace" || value.workspaceId !== undefined) });
export const CloudSdkStreamPayloadSchema = z.discriminatedUnion("t", [catalog, lifecycle, members, notification, revoked]);
export type CloudSdkStreamPayload = z.infer<typeof CloudSdkStreamPayloadSchema>;

/** Forward-compatible server fields, fully checked consumed fields. This
 * boundary is stricter than the SDK's platform-neutral envelope parser. */
export const CloudSdkDeviceFrameSchema = z.discriminatedUnion("t", [
  ...CloudSdkStreamPayloadSchema.options,
  z.object({ t: z.literal("ready"), d: z.object({ deviceSessionId: uuid, cursor, resumed: z.boolean(), contract: z.literal(1),
    heartbeatIntervalMs: z.number().int().min(5_000).max(60_000), organizationFeatures: features.optional() }) }),
  z.object({ t: z.literal("capability.renewed"), d: z.object({ workspaceId: uuid, clientSessionId: uuid, capabilities: CloudSdkCapabilitiesSchema }) }),
  z.object({ t: z.literal("catalog.reset"), d: z.object({ reason: code }) }),
  z.object({ t: z.literal("drain"), d: z.object({ reconnectAfterMs: version.max(60_000) }) }),
  z.object({ t: z.literal("heartbeat"), d: z.object({ ts: version }) }),
  z.object({ t: z.literal("pong"), d: z.object({ ts: version }) }),
  z.object({ t: z.literal("error"), d: z.object({ code, message: z.string().max(512), fatal: z.boolean() }) }),
]);

export const CloudSdkStreamSnapshotSchema = z.object({ streamId: uuid, leaseId: uuid.nullable(), sequence: version, revision: version,
  state: z.enum(["idle", "connecting", "open", "waiting", "stopped"]), catalogRequired: z.boolean(), organizations: features,
});
export type CloudSdkStreamSnapshot = z.infer<typeof CloudSdkStreamSnapshotSchema>;
export const CloudSdkStreamEventSchema = CloudSdkStreamSnapshotSchema.extend({ event: z.discriminatedUnion("type", [
  z.object({ type: z.literal("state") }),
  z.object({ type: z.literal("frame"), frame: CloudSdkStreamPayloadSchema }),
  z.object({ type: z.literal("renewal"), runtime: CloudSdkRuntimeIdentitySchema, capabilities: CloudSdkCapabilitiesSchema }),
]) });
export type CloudSdkStreamEvent = z.infer<typeof CloudSdkStreamEventSchema>;
