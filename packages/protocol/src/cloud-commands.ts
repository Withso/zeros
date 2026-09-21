import { z } from "zod";
import { CloudCommandActorSchema } from "./cloud-actors";

// Portable workspace bridge contract; no Electron, provider or host paths.
const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const revision = z.number().int().safe().nonnegative();
export const CloudConversationCreateSchema = z.object({ conversationId: identity, workspaceId: identity,
  agentId: identity, model: z.string().max(256).optional(), effort: z.string().max(64).optional(), title: z.string().max(1024).optional() }).strict();
export const CloudConversationReadSchema = z.object({ conversationId: identity }).strict();
export const CloudConversationModeSchema = z.object({ conversationId: identity, mode: z.enum(["code", "design"]), expectedRevision: revision }).strict();
const annotations = z.object({ audience: z.array(z.enum(["user", "assistant"])).max(2).optional(),
  lastModified: z.string().max(128).optional(), priority: z.number().min(0).max(1).optional() }).strict().optional();
const text = z.string().max(192 * 1024);
const uri = z.string().min(1).max(8192);
const mimeType = z.string().min(1).max(256);
const content = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text, annotations }).strict(),
  z.object({ type: z.literal("image"), data: text, mimeType, uri: uri.optional(), annotations }).strict(),
  z.object({ type: z.literal("audio"), data: text, mimeType, annotations }).strict(),
  z.object({ type: z.literal("resource_link"), uri, name: z.string().max(1024),
    description: text.optional(), mimeType: mimeType.optional(), size: revision.optional(), title: z.string().max(1024).optional(), annotations }).strict(),
  z.object({ type: z.literal("resource"), annotations, resource: z.union([
    z.object({ uri, text, mimeType: mimeType.optional() }).strict(),
    z.object({ uri, blob: text, mimeType: mimeType.optional() }).strict(),
  ]) }).strict(),
]);
export const CloudQueuedPromptSchema = z.object({
  agentId: identity, userMessageId: identity, prompt: z.array(content).min(1).max(128),
  bubble: z.record(z.string(), z.unknown()).optional(), modeRevision: revision,
  agentCredentialGrantId:z.uuid().optional(),
  model:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/).optional(),
  effort:z.enum(["low","medium","high","xhigh"]).optional(),fast:z.boolean().optional(),
}).strict().superRefine((value,context)=>{
  if(value.agentCredentialGrantId&&(!value.model||!["claude","cursor","codex"].includes(value.agentId)))
    context.addIssue({code:"custom",message:"Personal credential execution requires an explicit provider and model"});
});
export const CloudCommandMutationSchema = z.object({
  conversationId: identity, operationId: z.uuid(), expectedRevision: revision,
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("enqueue"), commandId: z.uuid(), payload: CloudQueuedPromptSchema }).strict(),
    z.object({ kind: z.literal("edit"), commandId: z.uuid(), payload: CloudQueuedPromptSchema }).strict(),
    z.object({ kind: z.literal("remove"), commandId: z.uuid() }).strict(),
    z.object({ kind: z.literal("pause") }).strict(), z.object({ kind: z.literal("resume") }).strict(),
  ]),
}).strict();
export const CloudCommandClientRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), conversationId: identity }).strict(),
  z.object({ kind: z.literal("read"), commandId: z.uuid() }).strict(),
  z.object({ kind: z.literal("mutate"), mutation: CloudCommandMutationSchema }).strict(),
  z.object({ kind: z.literal("stop"), conversationId: identity, operationId: z.uuid() }).strict(),
]);
export const CloudCommandEntrySchema = z.object({
  commandId: z.uuid(), position: revision, state: z.enum(["queued", "dispatching", "succeeded", "failed", "cancelled", "uncertain"]),
  payload: CloudQueuedPromptSchema.nullable(), executionId: identity.nullable(), generation: revision,
  resultCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export const CloudCommandSnapshotSchema = z.object({
  version: z.literal(1), conversationId: identity, revision, paused: z.boolean(),
  pending: z.array(CloudCommandEntrySchema).max(32), receipts: z.array(CloudCommandEntrySchema).max(50),
  replayed: z.boolean().optional(),
}).strict();
export const CloudCommandClaimSchema = z.object({
  commandId: z.uuid(), claimId: z.uuid(), conversationId: identity, executionId: identity, payload: CloudQueuedPromptSchema,
  dispatchAllowed:z.boolean().optional(),actor:CloudCommandActorSchema.optional(),
}).strict().superRefine((claim,context)=>{
  if ((claim.dispatchAllowed===true)!==(claim.actor!==undefined))
    context.addIssue({code:"custom",message:"Actor dispatch authority is incomplete"});
});
export type CloudQueuedPrompt = z.infer<typeof CloudQueuedPromptSchema>;
export type CloudCommandMutation = z.infer<typeof CloudCommandMutationSchema>;
export type CloudCommandClientRequest = z.infer<typeof CloudCommandClientRequestSchema>;
export type CloudCommandSnapshot = z.infer<typeof CloudCommandSnapshotSchema>;
export type CloudCommandClaim = z.infer<typeof CloudCommandClaimSchema>;
export type CloudCommandResult = { commandId: string; claimId: string; state: "succeeded" | "failed" | "cancelled"; resultCode: string | null };
export type CloudCommandEngineRequest = Exclude<CloudCommandClientRequest, { kind: "mutate" }> |
  { kind: "mutate"; mutation: CloudCommandMutation; admissionError: "command_context_changed" | "command_not_found" | null } |
  { kind: "claim"; conversationId: string; executionId: string; claimId?: string } |
  { kind: "settle"; result: CloudCommandResult };
