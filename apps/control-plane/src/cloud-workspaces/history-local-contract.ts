// Standalone Zod3 mirror: the control plane deploys independently of desktop.
import { createHash } from "node:crypto";
import { z } from "zod";
import { CloudAgentBootScopeSchema } from "./agent-boot-contract.js";
import { CloudCompactControlEventSchema } from "./event-streams.js";

export const HISTORY_PART_BYTES = 128 * 1024;
export const HISTORY_RECORD_BYTES = 512 * 1024;
export const HISTORY_MANIFEST_BYTES = 4 * 1024 * 1024;
export const HISTORY_BUNDLE_BYTES = 16 * 1024 * 1024;
export const HISTORY_WORKSPACE_BYTES = 1024 * 1024 * 1024;
const sequence = z.number().int().safe().nonnegative();
const positiveSequence = sequence.positive();
const identity = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const intent = z.object({ userMessageId: identity, agentId: z.string().min(1).max(64) }).strict();
const entityKind = z.enum(["chat", "message", "turn", "control"]);
const entityId = z.string().min(1).max(255).refine(value => !value.includes("\0"));
const incompleteReason = z.enum(["capture_unavailable", "capture_conflict", "history_limit", "recovery_uncertain"]);
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function boundedJson(value: unknown, maxNodes = 80_000): boolean {
  const pending = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > maxNodes || item.depth > 32) return false;
    if (item.value === null || typeof item.value === "string" || typeof item.value === "boolean") continue;
    if (typeof item.value === "number") { if (!Number.isFinite(item.value)) return false; continue; }
    if (!item.value || typeof item.value !== "object" || (!Array.isArray(item.value) && ![Object.prototype, null].includes(Object.getPrototypeOf(item.value)))) return false;
    if (Array.isArray(item.value) && Object.keys(item.value).length !== item.value.length) return false;
    const values = Object.values(item.value);
    if (pending.length + nodes + values.length > maxNodes) return false;
    for (const value of values) pending.push({ value, depth: item.depth + 1 });
  }
  return true;
}
export function canonicalCloudHistoryJson(value: unknown): string {
  if (!boundedJson(value, 256_000)) throw new Error("Invalid canonical history document");
  const encode = (item: unknown): string => {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    const object = item as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${encode(object[key])}`).join(",")}}`;
  };
  return encode(value);
}
const encodedBytes = (value: unknown) => {
  try { return Buffer.byteLength(canonicalCloudHistoryJson(value)); } catch { return Infinity; }
};
export const CloudLocalHistorySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), commandId: z.string().uuid(), intent,
    executionId: identity.nullable(), nativeResultSha256: digest.nullable() }).strict(),
  z.object({ kind: z.literal("mutation"), mutationId: z.string().uuid(), operation: z.enum(["edit", "delete", "prune", "repair"]) }).strict(),
]);
// Validate without rebuilding native JSON objects. Zod's record parser can
// discard an own __proto__ key, changing bytes that the CAS digest verified.
const document = z.custom<Record<string, Json>>(value => value !== null && typeof value === "object" &&
  !Array.isArray(value) && boundedJson(value), { message: "Canonical history document is not bounded JSON" });
const recordSchema = z.object({ version: z.literal(1), conversationId: identity, entityKind, entityId,
  schemaVersion: z.literal(1), sourceRevision: sequence, document,
}).strict().superRefine((value, context) => {
  if (encodedBytes(value) > HISTORY_RECORD_BYTES) context.addIssue({ code: "custom", message: "Canonical history record exceeds byte limit" });
  if (value.entityKind === "control") {
    const control = CloudCompactControlEventSchema.safeParse(value.document);
    if (!control.success || (control.data.frame.chatId !== undefined && control.data.frame.chatId !== value.conversationId))
      context.addIssue({ code: "custom", message: "Canonical control ownership is inconsistent" });
  }
});
export const CloudLocalHistoryRecordSchema = z.preprocess((value, context) => {
  if (!boundedJson(value)) { context.addIssue({ code: "custom", message: "Canonical history is not bounded JSON" }); return z.NEVER; }
  return value;
}, recordSchema);
export type CloudLocalHistoryRecord = z.infer<typeof CloudLocalHistoryRecordSchema>;
const historyRef = z.object({ entityKind, entityId, schemaVersion: z.literal(1), sourceRevision: sequence, sha256: digest }).strict();
const tombstone = z.object({ entityKind, entityId, sourceRevision: sequence }).strict();
export const CloudLocalHistoryManifestSchema = z.object({ version: z.literal(1), snapshot: z.literal("full"),
  scope: CloudAgentBootScopeSchema, conversationId: identity, restoreRevision: positiveSequence, deleted: z.boolean(),
  tombstones: z.array(tombstone).max(16_384), recordSequence: sequence, eventSequence: sequence,
  source: CloudLocalHistorySourceSchema, records: z.array(historyRef).max(16_384),
}).strict().superRefine((value, context) => {
  const key = (entry: { entityKind: string; entityId: string }) => `${entry.entityKind}\0${entry.entityId}`;
  const alive = new Set(value.records.map(key)), removed = new Set(value.tombstones.map(key));
  if (alive.size !== value.records.length || removed.size !== value.tombstones.length || value.records.some(record => removed.has(key(record))) ||
      (value.deleted && value.records.length > 0)) context.addIssue({ code: "custom", message: "Canonical full snapshot identities are inconsistent" });
  if (encodedBytes(value) > HISTORY_MANIFEST_BYTES) context.addIssue({ code: "custom", message: "Canonical history manifest exceeds byte limit" });
});
export type CloudLocalHistoryManifest = z.infer<typeof CloudLocalHistoryManifestSchema>;
export const CloudLocalHistoryPartSchema = z.object({ version: z.literal(1), kind: z.enum(["record", "manifest"]), sha256: digest,
  index: sequence, count: positiveSequence.max(32), bytes: positiveSequence.max(HISTORY_MANIFEST_BYTES),
  data: z.string().min(4).max(Math.ceil(HISTORY_PART_BYTES / 3) * 4),
}).strict().superRefine((value, context) => {
  const decoded = Buffer.from(value.data, "base64");
  if (decoded.toString("base64") !== value.data || value.index >= value.count || value.count !== Math.ceil(value.bytes / HISTORY_PART_BYTES) ||
      (value.kind === "record" && value.bytes > HISTORY_RECORD_BYTES) || decoded.length !== Math.min(HISTORY_PART_BYTES, value.bytes - value.index * HISTORY_PART_BYTES))
    context.addIssue({ code: "custom", message: "History part encoding or bounds are inconsistent" });
});
export type CloudLocalHistoryPart = z.infer<typeof CloudLocalHistoryPartSchema>;
export const CloudLocalHistoryWatermarkSchema = z.union([
  z.object({ restoreRevision: positiveSequence, recordSequence: sequence, eventSequence: sequence, manifestSha256: digest }).strict(),
  z.object({ restoreRevision: positiveSequence, recordSequence: sequence.nullable(), eventSequence: sequence.nullable(), incompleteReason }).strict(),
]);
export const CloudMirroredHistoryHeadSchema = z.object({ originWriterEpoch: z.string().uuid(), source: CloudLocalHistorySourceSchema,
  deleted: z.boolean(), history: CloudLocalHistoryWatermarkSchema }).strict();
export type CloudMirroredHistoryHead = z.infer<typeof CloudMirroredHistoryHeadSchema>;
export const CloudLocalHistoryHeadSchema = z.object({ conversationId: identity, originWriterEpoch: z.string().uuid(),
  source: CloudLocalHistorySourceSchema, restoreRevision: positiveSequence, deleted: z.boolean(), recordSequence: sequence.nullable(),
  eventSequence: sequence.nullable(), manifestSha256: digest.nullable(), incompleteReason: incompleteReason.nullable(),
}).strict().refine(value => value.manifestSha256 !== null
  ? value.recordSequence !== null && value.eventSequence !== null && value.incompleteReason === null : value.incompleteReason !== null);
export type CloudLocalHistoryHead = z.infer<typeof CloudLocalHistoryHeadSchema>;
export const CloudStoppedHistoryProjectionSchema = CloudAgentBootScopeSchema.extend({ version: z.literal(1), mode: z.literal("boot-owner-v1"),
  fundingScope: z.literal("workspace-roles-v1"), mirroredSequence: sequence, sealedSequence: sequence.nullable(), complete: z.boolean(),
}).strict().refine(value => !value.complete || (value.sealedSequence !== null && value.mirroredSequence >= value.sealedSequence));
export const CloudStoppedHistoryMetadataSchema = z.object({ projection: CloudStoppedHistoryProjectionSchema,
  historyHeads: z.array(CloudLocalHistoryHeadSchema).max(512) }).strict().superRefine((value, context) => {
  if (new Set(value.historyHeads.map(head => head.conversationId)).size !== value.historyHeads.length || encodedBytes(value) > 512 * 1024)
    context.addIssue({ code: "custom", message: "Stopped history metadata is duplicate or unbounded" });
});

/** Parts are immutable canonical bytes. Until all parts, digest, UTF8 and
 * closed document schema agree, the caller must not publish a complete head. */
export function assembleCloudHistoryDocument(supplied: readonly unknown[]): {
  kind: "record" | "manifest"; sha256: string; canonicalDocument: string; document: CloudLocalHistoryRecord | CloudLocalHistoryManifest;
} {
  if (supplied.length < 1 || supplied.length > 32) throw new Error("Invalid canonical history parts");
  const parts = supplied.map(value => CloudLocalHistoryPartSchema.parse(value)).sort((a, b) => a.index - b.index), first = parts[0]!;
  if (parts.length !== first.count || parts.some((part, index) => part.index !== index || part.kind !== first.kind ||
      part.sha256 !== first.sha256 || part.count !== first.count || part.bytes !== first.bytes)) throw new Error("Canonical history parts do not agree");
  const bytes = Buffer.concat(parts.map(part => Buffer.from(part.data, "base64")));
  if (bytes.length !== first.bytes || createHash("sha256").update(bytes).digest("hex") !== first.sha256) throw new Error("Canonical history digest does not agree");
  const canonicalDocument = new TextDecoder("utf-8", { fatal: true }).decode(bytes), value: unknown = JSON.parse(canonicalDocument);
  if (canonicalCloudHistoryJson(value) !== canonicalDocument) throw new Error("Canonical history encoding does not agree");
  const document = first.kind === "record" ? CloudLocalHistoryRecordSchema.parse(value) : CloudLocalHistoryManifestSchema.parse(value);
  if (canonicalCloudHistoryJson(document) !== canonicalDocument) throw new Error("Canonical history validation changed verified bytes");
  return { kind: first.kind, sha256: first.sha256, canonicalDocument, document };
}
