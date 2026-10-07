import { z } from "zod";
import { redactLogSecrets } from "@zeros/protocol/scrub";

export const CLOUD_TRANSCRIPT_CACHE_BYTES = 64 * 1024 * 1024;
export const CLOUD_TRANSCRIPT_WINDOW_BYTES = 512 * 1024;
export const CLOUD_TRANSCRIPT_CACHE_ENTRIES = 512;
export const CLOUD_TRANSCRIPT_WINDOW_MESSAGES = 200;
const integer = z.number().int().safe().nonnegative();
const printable = (value: string) => !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const id = z.string().min(1).max(255).refine(value => printable(value) && !value.includes("/") && !value.includes("\\"));
export const CloudTranscriptOwnerSchema = z.object({
  accountId: z.string().min(1).max(255).refine(printable),
  organizationId: z.string().uuid(), workspaceId: z.string().uuid(), chatId: id,
}).strict();
export type CloudTranscriptOwner = z.infer<typeof CloudTranscriptOwnerSchema>;
export const CloudTranscriptPruneSchema = CloudTranscriptOwnerSchema.partial().required({ accountId: true }).extend({
  retainedWorkspaces: z.array(CloudTranscriptOwnerSchema.pick({ organizationId: true, workspaceId: true })).max(2000).optional(),
}).refine(value => (!value.chatId || !!value.workspaceId && !!value.organizationId) &&
  (!value.retainedWorkspaces || !value.organizationId && !value.workspaceId && !value.chatId));
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
    cursor: page.cursor, messages };
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
