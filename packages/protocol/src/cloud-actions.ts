import { z } from "zod";
import { CloudQueuedPromptSchema } from "./cloud-commands";

const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const interaction = z.string().min(1).max(4096);
const permission = z.object({ outcome: z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("cancelled") }).strict(),
  z.object({ outcome: z.literal("selected"), optionId: interaction }).strict(),
]) }).strict();
const question = z.object({ outcome: z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("declined") }).strict(),
  z.object({ outcome: z.literal("dismissed") }).strict(),
  z.object({ outcome: z.literal("answered"), answers: z.array(z.object({
    questionId: interaction, selectedOptionIds: z.array(interaction).max(128), freeText: z.string().max(65536).optional(),
  }).strict()).max(64) }).strict(),
]) }).strict();
const base = { operationId: z.uuid(), conversationId: identity, executionId: identity, requestId: identity };
export const CloudActionSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("permission"), payload: z.object({ response: permission }).strict() }).strict(),
  z.object({ ...base, kind: z.literal("question"), payload: z.object({ response: question, nativeRequestId: interaction.optional() }).strict() }).strict(),
  z.object({ ...base, kind: z.literal("steer"), payload: z.object({
    agentId: identity, turnId: identity, userMessageId: identity,
    prompt: CloudQueuedPromptSchema.shape.prompt, bubble: CloudQueuedPromptSchema.shape.bubble,
  }).strict() }).strict().refine(action => action.requestId === action.payload.userMessageId, { message: "Steering identity must match its user message" }),
]);
export const CloudActionClientRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), operationId: z.uuid() }).strict(),
  z.object({ kind: z.literal("submit"), action: CloudActionSchema }).strict(),
]);
export const CloudActionReceiptSchema = z.object({
  operationId: z.uuid(), conversationId: identity, executionId: identity,
  kind: z.enum(["permission", "question", "steer"]), requestId: identity,
  state: z.enum(["dispatching", "settled", "uncertain"]),
  outcome: z.enum(["delivered", "queued", "interrupted"]).nullable(), turnId: identity.nullable(),
  claimId: z.uuid(), replayed: z.boolean(),
}).strict();
export type CloudAction = z.infer<typeof CloudActionSchema>;
export type CloudActionReceipt = z.infer<typeof CloudActionReceiptSchema>;
export type CloudActionEngineRequest =
  { kind: "read"; operationId: string } |
  { kind: "begin"; action: CloudAction; admissible: boolean } |
  { kind: "settle"; operationId: string; claimId: string; outcome: "delivered" | "queued" | "interrupted"; turnId: string | null };
