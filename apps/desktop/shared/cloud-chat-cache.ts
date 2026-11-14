import { z } from "zod";
import { CloudV2HistoryStateSchema } from "@zeros/protocol/cloud-v2-relay";
import { CloudV2PromptCounterSchema, CloudV2PromptIdSchema, CloudV2PromptStatusSchema } from "@zeros/protocol/cloud-v2-prompts";

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const CloudCacheTargetSchema = z.object({
  organizationId: z.string().uuid(), workspaceId: z.string().uuid(), chatId: CloudV2PromptIdSchema,
}).strict();
export const CloudCacheKeySchema = CloudCacheTargetSchema.extend({ owner: z.string().min(1).max(2048) });
export type CloudCacheTarget = z.infer<typeof CloudCacheTargetSchema>;
export type CloudCacheKey = z.infer<typeof CloudCacheKeySchema>;
export const CloudCacheMessageSchema = z.object({
  msgId: CloudV2PromptIdSchema, kind: z.string().min(1).max(64), payload: z.string().max(64 * 1024 * 1024),
  createdAt: counter, index: counter.optional(),
});
export const CloudCacheRowSchema = CloudCacheMessageSchema.extend({ index: counter });
export type CloudCacheRow = z.infer<typeof CloudCacheRowSchema>;
const metadata = { revision: counter, messageCount: counter, historyState: CloudV2HistoryStateSchema.optional() };
/** Team sharing: who sent each user row in this reply ({userId} or null for a known-unknown legacy attribution).
 * Read leniently, like a window's senders: unknown or malformed entries are ignored, absence means not answered. */
export const CloudCacheSendersSchema = z.record(z.string().min(1).max(256), z.unknown());
export const CloudCacheRangeSchema = z.object({
  ...metadata, fromIndex: counter, toIndex: counter, rows: z.array(CloudCacheRowSchema).max(500),
  turnOpening: CloudCacheMessageSchema.optional(), senders: CloudCacheSendersSchema.optional(),
}).refine(page => page.fromIndex <= page.toIndex && page.toIndex <= page.messageCount &&
  page.toIndex - page.fromIndex === page.rows.length &&
  page.rows.every((row, index) => row.index === page.fromIndex + index) &&
  new Set(page.rows.map(row => row.msgId)).size === page.rows.length, "Invalid cloud cache range");
export type CloudCacheRange = z.infer<typeof CloudCacheRangeSchema>;
export const CloudCacheDeltaSchema = z.discriminatedUnion("resync", [
  z.object({ resync: z.literal(true), ...metadata }),
  z.object({ resync: z.literal(false), fromRevision: counter, ...metadata, rows: z.array(CloudCacheRowSchema).max(500),
    senders: CloudCacheSendersSchema.optional() })
    .refine(delta => delta.fromRevision <= delta.revision && delta.rows.every(row => row.index < delta.messageCount) &&
      delta.rows.every((row, index) => index === 0 || row.index > delta.rows[index - 1].index) &&
      new Set(delta.rows.map(row => row.index)).size === delta.rows.length &&
      new Set(delta.rows.map(row => row.msgId)).size === delta.rows.length &&
      (delta.fromRevision !== delta.revision || delta.rows.length === 0), "Invalid cloud cache delta"),
]);
export type CloudCacheDelta = z.infer<typeof CloudCacheDeltaSchema>;
export const CloudCachePendingRowSchema = CloudV2PromptStatusSchema;
export type CloudCachePendingRow = z.infer<typeof CloudCachePendingRowSchema>;
export const CloudCachePendingSchema = z.object({
  queueRevision: counter, epoch: CloudV2PromptCounterSchema, items: z.array(CloudCachePendingRowSchema).max(50_000),
}).refine(page => new Set(page.items.map(item => item.receipt.userMessageId)).size === page.items.length &&
  page.items.every((item, index) => BigInt(item.receipt.epoch) <= BigInt(page.epoch) &&
    (index === 0 || BigInt(item.receipt.sequence) > BigInt(page.items[index - 1].receipt.sequence))));
export type CloudCachePending = z.infer<typeof CloudCachePendingSchema>;
export const cloudCacheKey = (key: CloudCacheKey): string => {
  const parsed = CloudCacheKeySchema.parse(key);
  return JSON.stringify([parsed.owner, parsed.organizationId, parsed.workspaceId, parsed.chatId]);
};

const leased = { lease: z.string().uuid() };
const limited = { target: CloudCacheTargetSchema, limit: z.number().int().min(1).max(500) };
/** A chat's {revision, messageCount} as the chats.list read that proved access reported it. */
export const CloudCacheKnownSchema = z.object({ revision: counter, messageCount: counter }).strict();
export type CloudCacheKnown = z.infer<typeof CloudCacheKnownSchema>;
export const CloudCacheRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("bind"), owner: z.string().min(1).max(2048), client: z.string().min(1).max(128) }).strict(),
  z.object({ op: z.literal("read"), ...leased, ...limited }).strict(),
  z.object({ op: z.literal("read-before"), ...leased, ...limited, revision: counter, before: CloudV2PromptIdSchema }).strict(),
  z.object({ op: z.literal("refresh"), ...leased, ...limited, known: CloudCacheKnownSchema.optional() }).strict(),
  z.object({ op: z.literal("refresh-before"), ...leased, ...limited, before: CloudV2PromptIdSchema }).strict(),
  z.object({ op: z.literal("refresh-pending"), ...leased, target: CloudCacheTargetSchema }).strict(),
  z.object({ op: z.literal("protect"), ...leased, target: CloudCacheTargetSchema.nullable() }).strict(),
  z.object({ op: z.literal("forget"), ...leased, targets: z.array(CloudCacheTargetSchema).min(1).max(500) }).strict(),
  z.object({ op: z.literal("list"), ...leased, after: z.string().max(16_384).nullable() }).strict(),
  z.object({ op: z.literal("release"), ...leased }).strict(),
]);
export type CloudCacheRequest = z.infer<typeof CloudCacheRequestSchema>;
export const CloudCacheReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(["unavailable", "owner_changed", "unsupported", "access_lost"]),
    scope: z.enum(["workspace", "chat"]).optional() }).strict(),
]);
export type CloudCacheReply = z.infer<typeof CloudCacheReplySchema>;
