// Mirror of packages/protocol/src/cloud-v2-prompts.ts. The control plane builds
// standalone with Zod 3; contract-parity tests keep the wire schemas aligned.
import { z } from "zod";

export const CLOUD_V2_MAX_PROMPT_BYTES = 8 * 1024 * 1024;
export const CLOUD_V2_PROMPT_POLL_MS = 25_000;
export const CloudV2PromptIdSchema = z.string().min(1).max(256).regex(/^(?!cloud:)[^\u0000-\u001f]+$/);
export const CloudV2PromptCounterSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(value => /^[0-9]+$/.test(value) && BigInt(value) < 9223372036854775807n);
const text = z.string().max(CLOUD_V2_MAX_PROMPT_BYTES);
const annotations = z.object({ audience: z.array(z.enum(["user", "assistant"])).max(2).optional(),
  lastModified: z.string().max(128).optional(), priority: z.number().min(0).max(1).optional() }).strict().optional();
const content = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text, annotations }).strict(),
  z.object({ type: z.literal("image"), data: text, mimeType: z.string().max(128), uri: text.optional(), annotations }).strict(),
  z.object({ type: z.literal("audio"), data: text, mimeType: z.string().max(128), annotations }).strict(),
  z.object({ type: z.literal("resource_link"), uri: text, name: z.string().max(1024), description: text.optional(),
    mimeType: z.string().max(128).optional(), size: z.number().nonnegative().optional(), title: z.string().max(1024).optional(), annotations }).strict(),
  z.object({ type: z.literal("resource"), resource: z.union([
    z.object({ uri: text, text, mimeType: z.string().max(128).optional() }).strict(),
    z.object({ uri: text, blob: text, mimeType: z.string().max(128).optional() }).strict(),
  ]), annotations }).strict(),
]);
const attachment = z.object({ name: z.string().max(1024), mimeType: z.string().max(128), kind: z.enum(["image", "text", "file"]),
  delivery: z.literal("reference").optional(), size: z.number().nonnegative().optional(), thumbnailUri: text.optional(),
  diskPath: z.string().max(2048).optional(), attachmentId: z.string().max(256).optional() }).strict();
const attachmentGroup = z.object({ id: z.string().min(1).max(160), name: z.string().min(1).max(512) }).strict().optional();
export const CloudV2PromptSchema = z.object({
  chatId: CloudV2PromptIdSchema, userMessageId: CloudV2PromptIdSchema,
  agentId: z.enum(["codex", "claude", "cursor"]), model: z.string().max(256).optional(), effort: z.string().max(64).optional(),
  mode: z.enum(["prompt", "steer"]).optional(),
  prompt: z.array(content).min(1).max(256), startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bubble: z.object({ retryText: text.optional(), displayText: text.optional(), autoAction: z.string().max(256).optional(),
    attachments: z.array(attachment).max(100).optional(), segments: z.array(z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text }).strict(),
      z.object({ type: z.literal("mention"), label: z.string().max(1024), path: z.string().max(2048), kind: z.enum(["file", "folder", "selection"]) }).strict(),
      attachment.extend({ type: z.literal("attachment"), group: attachmentGroup }).strict(),
    ])).max(512).optional(),
  }).strict().optional(),
}).strict();
export type CloudV2Prompt = z.infer<typeof CloudV2PromptSchema>;
export const CloudV2PromptReceiptSchema = z.object({
  workspaceId: z.string().uuid(), chatId: CloudV2PromptIdSchema, userMessageId: CloudV2PromptIdSchema,
  sequence: CloudV2PromptCounterSchema, epoch: CloudV2PromptCounterSchema, acceptedAt: z.string().datetime(),
  workspaceState: z.enum(["creating", "running", "stopping", "stopped", "starting", "deleting", "deleted", "failed"]),
}).strict();
export type CloudV2PromptReceipt = z.infer<typeof CloudV2PromptReceiptSchema>;
export const CloudV2PromptStateSchema = z.enum(["queued", "inboxed", "dispatching", "accepted", "completed", "failed", "cancelled", "interrupted"]);
export type CloudV2PromptState = z.infer<typeof CloudV2PromptStateSchema>;
export const CloudV2PromptStatusSchema = z.object({ receipt: CloudV2PromptReceiptSchema, state: CloudV2PromptStateSchema,
  payload: CloudV2PromptSchema.nullable(), cancelRequested: z.boolean() }).strict();
export type CloudV2PromptStatus = z.infer<typeof CloudV2PromptStatusSchema>;
export const CloudV2PromptStopSchema = z.object({ chatId: CloudV2PromptIdSchema, throughEpoch: CloudV2PromptCounterSchema }).strict();
export const CloudV2PromptStopReplySchema = z.object({ chatId: CloudV2PromptIdSchema, epoch: CloudV2PromptCounterSchema }).strict();
export const CloudV2PromptPullSchema = z.object({ waitMs: z.number().int().min(0).max(CLOUD_V2_PROMPT_POLL_MS),
  held: z.array(CloudV2PromptIdSchema).max(128).optional() }).strict();
export const CloudV2PromptDeliverySchema = z.object({ receipt: CloudV2PromptReceiptSchema, payload: CloudV2PromptSchema, deliveryId: z.string().uuid() }).strict();
export type CloudV2PromptDelivery = z.infer<typeof CloudV2PromptDeliverySchema>;
export const CloudV2PromptPullReplySchema = z.object({ prompts: z.array(CloudV2PromptDeliverySchema).max(16), stops: z.array(CloudV2PromptStopReplySchema).max(128) }).strict();
export type CloudV2PromptPullReply = z.infer<typeof CloudV2PromptPullReplySchema>;
export const CloudV2PromptAckSchema = z.object({ userMessageId: CloudV2PromptIdSchema, deliveryId: z.string().uuid() }).strict();
export const CloudV2PromptBeginSchema = CloudV2PromptAckSchema.extend({ dispatchId: z.string().uuid() });
export const CloudV2PromptOutcomeSchema = z.object({ userMessageId: CloudV2PromptIdSchema, dispatchId: z.string().uuid().optional(),
  deliveryId: z.string().uuid().optional(), state: z.enum(["accepted", "completed", "failed", "cancelled", "interrupted"]) }).strict()
  .refine(value => !!value.dispatchId || (!!value.deliveryId && value.state !== "accepted"));
