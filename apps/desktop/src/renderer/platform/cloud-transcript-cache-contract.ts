import { z } from "zod";
import { redactLogSecrets } from "@zeros/protocol/scrub";
import { CloudAgentBootScopeSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudLocalCommandHistorySourceSchema } from "@zeros/protocol/cloud-local-mirror";

export const CLOUD_TRANSCRIPT_CACHE_BYTES = 64 * 1024 * 1024;
export const CLOUD_TRANSCRIPT_WINDOW_BYTES = 512 * 1024;
export const CLOUD_TRANSCRIPT_CACHE_ENTRIES = 512;
export const CLOUD_TRANSCRIPT_WINDOW_MESSAGES = 200;
const integer = z.number().int().safe().nonnegative();
const historyIdentity = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
export const CloudHistoryProjectionSchema = CloudAgentBootScopeSchema.extend({
  version: z.literal(1), mode: z.literal("boot-owner-v1"), fundingScope: z.literal("workspace-roles-v1"),
  mirroredSequence: integer, sealedSequence: integer.nullable(), complete: z.boolean(),
}).strict().refine(value => !value.complete || value.sealedSequence !== null && value.mirroredSequence >= value.sealedSequence);
export type CloudHistoryProjection = z.infer<typeof CloudHistoryProjectionSchema>;
export const CloudHistoryRestoreHeadSchema = z.object({
  conversationId: historyIdentity, originWriterEpoch: z.uuid(), source: CloudLocalCommandHistorySourceSchema,
  restoreRevision: integer.positive(), deleted: z.boolean(), recordSequence: integer.nullable(), eventSequence: integer.nullable(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  incompleteReason: z.enum(["capture_unavailable", "capture_conflict", "history_limit", "recovery_uncertain"]).nullable(),
}).strict().refine(value => value.manifestSha256 !== null
  ? value.recordSequence !== null && value.eventSequence !== null && value.incompleteReason === null : value.incompleteReason !== null);
export type CloudHistoryRestoreHead = z.infer<typeof CloudHistoryRestoreHeadSchema>;
export const CloudHistoryRestoreMetadataSchema = z.object({ projection: CloudHistoryProjectionSchema,
  historyHeads: z.array(CloudHistoryRestoreHeadSchema).max(512),
}).strict().superRefine((value, context) => {
  if (new Set(value.historyHeads.map(head => head.conversationId)).size !== value.historyHeads.length ||
      new TextEncoder().encode(JSON.stringify(value)).byteLength > 512 * 1024 ||
      value.projection.complete && value.historyHeads.some(head => head.incompleteReason !== null))
    context.addIssue({ code: "custom", message: "Cloud restore authority is duplicate, incomplete or unbounded" });
});
export type CloudHistoryRestoreMetadata = z.infer<typeof CloudHistoryRestoreMetadataSchema>;
export const CloudHistoryRestoreFenceSchema = z.object({ projection: CloudHistoryProjectionSchema,
  conversationId: historyIdentity, head: CloudHistoryRestoreHeadSchema.nullable(),
}).strict().refine(value => value.head === null || value.head.conversationId === value.conversationId);
export type CloudHistoryRestoreFence = z.infer<typeof CloudHistoryRestoreFenceSchema>;
export function cloudHistoryBindingKey(value: CloudHistoryProjection): string {
  return JSON.stringify([value.organizationId, value.workspaceId, value.generation, value.engineInstanceId,
    value.bootId, value.writerEpoch, value.fundingOwnerUserId, value.fundingOwnerEpoch]);
}
export function cloudHistoryFenceHasTranscript(value: CloudHistoryRestoreFence): boolean {
  return value.head !== null && !value.head.deleted && value.head.incompleteReason === null;
}
export function cloudHistoryFencesMatch(a: CloudHistoryRestoreFence, b: CloudHistoryRestoreFence): boolean {
  return cloudHistoryBindingKey(a.projection) === cloudHistoryBindingKey(b.projection) &&
    a.conversationId === b.conversationId && JSON.stringify(a.head) === JSON.stringify(b.head);
}
/** Restore revisions are comparable only within the authenticated projection.
 * A changed binding is installed using a captured per-conversation epoch. */
export function cloudHistoryFenceCanAdvance(previous: CloudHistoryRestoreFence, next: CloudHistoryRestoreFence): boolean {
  if (cloudHistoryBindingKey(previous.projection) !== cloudHistoryBindingKey(next.projection)) return true;
  if (next.projection.mirroredSequence < previous.projection.mirroredSequence) return false;
  if (previous.head && next.head) {
    if (next.head.restoreRevision < previous.head.restoreRevision) return false;
    if (next.head.restoreRevision === previous.head.restoreRevision && JSON.stringify(next.head) !== JSON.stringify(previous.head))
      throw new Error("Cloud restore head conflicts with its immutable source.");
  }
  return true;
}
const printable = (value: string) => !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const id = z.string().min(1).max(255).refine(value => printable(value) && !value.includes("/") && !value.includes("\\"));
export const CloudTranscriptOwnerSchema = z.object({
  accountId: z.string().min(1).max(255).refine(printable),
  organizationId: z.string().uuid(), workspaceId: z.string().uuid(), chatId: id,
}).strict();
export type CloudTranscriptOwner = z.infer<typeof CloudTranscriptOwnerSchema>;
export const CloudTranscriptPruneSchema = CloudTranscriptOwnerSchema.partial().required({ accountId: true }).extend({
  retainedWorkspaces: z.array(CloudTranscriptOwnerSchema.pick({ organizationId: true, workspaceId: true })).max(2000).optional(),
  restoreHead: CloudHistoryRestoreFenceSchema.optional(), cacheEpoch: z.uuid().optional(), historyEpoch: z.uuid().optional(),
}).refine(value => (!value.chatId || !!value.workspaceId && !!value.organizationId) &&
  (!value.retainedWorkspaces || !value.organizationId && !value.workspaceId && !value.chatId) &&
  (!value.restoreHead || value.chatId === value.restoreHead.conversationId &&
    value.organizationId === value.restoreHead.projection.organizationId && value.workspaceId === value.restoreHead.projection.workspaceId));
export type CloudTranscriptPrune = z.infer<typeof CloudTranscriptPruneSchema>;

// A cache is a presentation copy, never an auth/retry/tool-execution record.
// Private tool inputs/results and expanded prompts are deliberately excluded.
function presentationText(value: string): string {
  return redactLogSecrets(value)
    .replace(/-----BEGIN [^-\n]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [^-\n]+-----|$)/gu, "[redacted]")
    .replace(/(?:data:[^\s<>"']+|file:\/\/[^\s<>"']+)/giu, "[attachment]")
    .replace(/(^|[\s"'`(=:])\/(?!\/)[^\s<>"'`),;]+/gu, "$1[workspace]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, "[redacted]");
}
const text = z.string().max(CLOUD_TRANSCRIPT_WINDOW_BYTES).transform(presentationText);
const base = { id, createdAt: integer, parentToolId: id.optional() };
const attachment = z.object({
  name: text, mimeType: z.string().max(255), kind: z.enum(["image", "text", "file"]),
  attachmentId: id.optional(), delivery: z.literal("reference").optional(), size: integer.optional(),
});
const question = z.object({
  id, prompt: text, header: text.optional(), inputType: z.enum(["choice", "multi_choice", "text", "yesno"]),
  options: z.array(z.object({ id, label: text, description: text.optional(), preview: text.optional() })).max(64).optional(),
  placeholder: text.optional(), allowOther: z.boolean().optional(), secret: z.boolean().optional(),
  answer: z.object({ selectedOptionIds: z.array(id).max(64), freeText: text.optional() }).optional(),
}).transform(value => value.secret ? { ...value, answer: undefined } : value);
const presentationMessage = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("text"), role: z.enum(["user", "agent", "thought", "system"]), text,
    updatedAt: integer.optional(), messageId: id.optional(), phase: z.enum(["commentary", "final_answer"]).optional(),
    redacted: z.boolean().optional(), retracted: z.literal(true).optional(), durationMs: integer.optional(),
    summaryBoundary: z.boolean().optional(), resumeBoundary: z.boolean().optional(), attachments: z.array(attachment).max(64).optional() }),
  z.object({ ...base, kind: z.literal("tool"), toolCallId: id, nativeToolCallId: id.optional(), title: text,
    toolKind: z.string().max(255).optional(), status: z.enum(["pending", "in_progress", "completed", "failed"]),
    updatedAt: integer, settledAt: integer.optional(), resultRetracted: z.boolean().optional(), resultRevision: integer.optional() }),
  z.object({ ...base, kind: z.literal("thinking"), text, messageId: id.optional(), durationMs: integer.optional(), redacted: z.boolean().optional() }),
  z.object({ ...base, kind: z.literal("question"), source: z.enum(["native_dialog", "native_rpc", "native_tool", "inferred_from_text"]),
    toolCallId: id.optional(), questionId: id.optional(), nativeRequestId: id.optional(), questions: z.array(question).max(64), blocking: z.boolean() }),
  z.object({ ...base, kind: z.literal("mode_switch"), axis: z.enum(["phase", "permission", "tier"]), from: text, to: text,
    source: z.enum(["user", "agent"]), reason: text.optional(), requiresApproval: z.boolean().optional() }),
  z.object({ ...base, kind: z.literal("subagent"), marker: z.enum(["start", "end"]), subagentId: id, parentToolId: id,
    description: text.optional(), summary: text.optional() }),
  z.object({ ...base, kind: z.literal("error_notice"), severity: z.enum(["warning", "error"]), message: text,
    recoverable: z.boolean(), code: id.optional(), failureKind: id.optional(), turnFailure: z.object({ turnId: id, kind: id }).optional() }),
]);
export const CachedTranscriptMessageSchema = z.object({ msgId: id, kind: z.string().max(64), payload: z.string().max(3 * 1024 * 1024), createdAt: integer }).strict();
export type CachedTranscriptMessage = z.infer<typeof CachedTranscriptMessageSchema>;
export const CachedTranscriptWindowSchema = z.object({
  // The passive projection API exposes a monotonically increasing revision,
  // but no epoch. Null means unknown; it must never be invented from a VM.
  recordEpoch: z.string().min(1).max(255).nullable(), revision: integer, cursor: id.nullable(),
  messages: z.array(CachedTranscriptMessageSchema).max(CLOUD_TRANSCRIPT_WINDOW_MESSAGES),
  restoreHead: CloudHistoryRestoreFenceSchema.optional(),
}).strict();
export type CachedTranscriptWindow = z.infer<typeof CachedTranscriptWindowSchema>;

export function transcriptCacheKey(owner: CloudTranscriptOwner): string {
  const key = CloudTranscriptOwnerSchema.parse(owner);
  return JSON.stringify([key.accountId, key.organizationId, key.workspaceId, key.chatId]);
}

/** Strict field selection is repeated in main, even for renderer writes.
 * Unknown/private bodies cannot enter the durable cache through native IPC. */
export function prepareCachedTranscriptWindow(input: unknown): CachedTranscriptWindow {
  const page = CachedTranscriptWindowSchema.extend({ messages: z.array(CachedTranscriptMessageSchema).max(1000) }).parse(input);
  const messages: CachedTranscriptMessage[] = [];
  for (const row of page.messages.slice(-CLOUD_TRANSCRIPT_WINDOW_MESSAGES)) {
    if (row.payload.length > CLOUD_TRANSCRIPT_WINDOW_BYTES) continue;
    try {
      const parsed = presentationMessage.safeParse(JSON.parse(row.payload));
      if (!parsed.success || parsed.data.id !== row.msgId || parsed.data.kind !== row.kind) continue;
      messages.push({ ...row, payload: JSON.stringify(parsed.data) });
    } catch { /* An unreadable row is not a confirmed presentation snapshot. */ }
  }
  const result: CachedTranscriptWindow = { recordEpoch: page.recordEpoch, revision: page.revision,
    cursor: page.cursor, messages, ...(page.restoreHead ? { restoreHead: page.restoreHead } : {}) };
  const encoder = new TextEncoder();
  let bytes = encoder.encode(JSON.stringify({ ...result, messages: [] })).byteLength;
  let first = messages.length;
  for (let index = messages.length - 1; index >= 0; index--) {
    const nextBytes = bytes + encoder.encode(JSON.stringify(messages[index])).byteLength + (first < messages.length ? 1 : 0);
    if (nextBytes > CLOUD_TRANSCRIPT_WINDOW_BYTES - 4096) break;
    bytes = nextBytes;
    first = index;
  }
  messages.splice(0, first);
  return result;
}
