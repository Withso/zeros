import { z } from "zod";
import { CloudBootCommandMutationSchema } from "@zeros/protocol/cloud-commands";
import { CloudSdkRuntimeIdentitySchema } from "./cloud-sdk-contract";

export const CLOUD_SDK_COMMAND_MAX_BYTES = 256 * 1024;
export const CLOUD_SDK_COMMAND_ENVELOPE_MAX_BYTES = CLOUD_SDK_COMMAND_MAX_BYTES + 8 * 1024;
const uuid = z.string().uuid();
const requestId = z.string().min(1).max(128);
const connection = { runtime: CloudSdkRuntimeIdentitySchema, attemptId: uuid };

/** Select a native-recorded handshake, never a renderer-provided route or
 * capability. A retired attempt cannot be activated again. */
export const CloudSdkConnectionControlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("activate"), runtime: CloudSdkRuntimeIdentitySchema,
    handshakeNonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }).strict(),
  z.object({ action: z.literal("retire"), ...connection }).strict(),
  z.object({ action: z.literal("cancel"), ...connection, requestId }).strict(),
]);
export const CloudSdkConnectionReceiptSchema = z.object({ attemptId: uuid }).strict();
export const CloudSdkCommandEnvelopeRequestSchema = z.object({ ...connection,
  command: z.string().min(1).max(CLOUD_SDK_COMMAND_MAX_BYTES) }).strict();

/** The only frame native may decorate. Other operations and legacy grants
 * retain their existing transport; supplied proof material is always refused. */
export const CloudSdkUnsignedCommandSchema = z.object({
  id: requestId, source: z.literal("browser"), timestamp: z.number().int().nonnegative().safe(),
  type: z.literal("WORKSPACE_REQUEST"), op: z.literal("cloudCommands.request"),
  params: z.object({
    cloudLocalCommandsVersion: z.literal(1), bootId: uuid, writerEpoch: uuid,
    nativeCommandsVersion: z.literal(1).optional(), cloudTurnProtocolVersion: z.literal(1).optional(),
    claudePreferencesVersion: z.literal(1).optional(),
    request: z.object({ kind: z.literal("mutate"), mutation: CloudBootCommandMutationSchema }).strict(),
  }).strict(),
}).strict();
