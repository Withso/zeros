// Separate from bootstrap so compact controls never create an import cycle
// through bootstrap -> commands -> cloud-events -> bootstrap.
import { z } from "zod";
import { CloudActorProvenanceSchema, CloudAgentBootScopeSchema, CloudAgentCredentialRunInfoSchema } from "./cloud-agent-bootstrap";
import { CloudBootCommandEntrySchema, CloudGoalSnapshotSchema } from "./cloud-commands";
// W4 owns this closed/bounded control frame schema in cloud-events.ts.
import { CloudCompactControlFrameSchema } from "./cloud-events";

const identity = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const sequence = z.number().int().safe().nonnegative();
const positiveSequence = sequence.positive();
export const CLOUD_LOCAL_COMMAND_MIRROR_MAX_BYTES = 1024 * 1024;
export const CLOUD_COMPACT_CONTROL_MAX_BYTES = 256 * 1024;
export const CLOUD_LOCAL_COMMAND_HISTORY_RECORD_MAX_BYTES = 512 * 1024;
export const CLOUD_LOCAL_COMMAND_HISTORY_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
/** Full cumulative conversation snapshot, not a per-message allowance. */
export const CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES = 16 * 1024 * 1024;
export const CLOUD_LOCAL_COMMAND_HISTORY_PART_MAX_BYTES = 128 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const intent = z.object({ userMessageId: identity, agentId: z.string().min(1).max(64) }).strict();
const entityKind = z.enum(["chat", "message", "turn", "control"]);
const entityId = z.string().min(1).max(255).refine(value => !value.includes("\0"));

/** Validate JSON iteratively before recursive schemas/stringification. */
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
/** Exact canonical UTF-8 representation shared with engine consumers; CP
 * retains its independent implementation and validates parity in tests. */
export function canonicalCloudLocalCommandHistoryJson(value: unknown): string {
  // A shallow manifest can contain both 16384 refs and 16384 tombstones.
  // Per-record JSON has its stricter 80k pre-parse bound below.
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
  try { return new TextEncoder().encode(canonicalCloudLocalCommandHistoryJson(value)).byteLength; }
  catch { return Infinity; }
};
type HistoryJsonValue = null | string | number | boolean | HistoryJsonValue[] | { [key: string]: HistoryJsonValue };
/** Keep the verified JSON representation intact, including literal data
 * keys such as __proto__. Recursive z.record/z.json parsing drops that key,
 * changing a digest-verified document. No assignment/merge is performed. */
const historyDocument = z.custom<Record<string, HistoryJsonValue>>(value =>
  !!value && typeof value === "object" && !Array.isArray(value) && boundedJson(value));
const historyRecord = z.object({ version: z.literal(1), conversationId: identity, entityKind, entityId,
  schemaVersion: z.literal(1), sourceRevision: sequence, document: historyDocument,
}).strict().superRefine((value, context) => {
  if (encodedBytes(value) > CLOUD_LOCAL_COMMAND_HISTORY_RECORD_MAX_BYTES)
    context.addIssue({ code: "custom", message: "Canonical history record exceeds byte limit" });
  if (value.entityKind === "control") {
    const control = CloudCompactControlEventSchema.safeParse(value.document);
    if (!control.success || (control.data.frame.chatId !== undefined && control.data.frame.chatId !== value.conversationId))
      context.addIssue({ code: "custom", message: "Canonical control ownership is inconsistent" });
  }
});
export const CloudLocalCommandHistoryRecordSchema = z.preprocess((value, context) => {
  if (!boundedJson(value)) { context.addIssue({ code: "custom", message: "Canonical history is not bounded JSON" }); return z.NEVER; }
  return value;
}, historyRecord);
export type CloudLocalCommandHistoryRecord = z.infer<typeof CloudLocalCommandHistoryRecordSchema>;
const historyRef = z.object({ entityKind, entityId, schemaVersion: z.literal(1), sourceRevision: sequence, sha256: digest }).strict();
const tombstone = z.object({ entityKind, entityId, sourceRevision: sequence }).strict();
export const CloudLocalCommandHistorySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), commandId: z.uuid(), intent, executionId: identity.nullable(), nativeResultSha256: digest.nullable() }).strict(),
  z.object({ kind: z.literal("mutation"), mutationId: z.uuid(), operation: z.enum(["edit", "delete", "prune", "repair"]) }).strict(),
]);
export type CloudLocalCommandHistorySource = z.infer<typeof CloudLocalCommandHistorySourceSchema>;
export const CloudLocalCommandHistoryManifestSchema = z.object({
  version: z.literal(1), snapshot: z.literal("full"), scope: CloudAgentBootScopeSchema, conversationId: identity,
  restoreRevision: positiveSequence, deleted: z.boolean(), tombstones: z.array(tombstone).max(16_384),
  recordSequence: sequence, eventSequence: sequence,
  source: CloudLocalCommandHistorySourceSchema, records: z.array(historyRef).max(16_384),
}).strict().superRefine((value, context) => {
  const key = (entry: { entityKind: string; entityId: string }) => `${entry.entityKind}\0${entry.entityId}`;
  const alive = new Set(value.records.map(key)), deleted = new Set(value.tombstones.map(key));
  if (alive.size !== value.records.length || deleted.size !== value.tombstones.length || value.records.some(record => deleted.has(key(record))) ||
      (value.deleted && value.records.length > 0))
    context.addIssue({ code: "custom", message: "Canonical full snapshot identities are inconsistent" });
  if (encodedBytes(value) > CLOUD_LOCAL_COMMAND_HISTORY_MANIFEST_MAX_BYTES)
    context.addIssue({ code: "custom", message: "Canonical history manifest exceeds byte limit" });
});
export type CloudLocalCommandHistoryManifest = z.infer<typeof CloudLocalCommandHistoryManifestSchema>;
export const CloudLocalCommandHistoryPartSchema = z.object({
  version: z.literal(1), kind: z.enum(["record", "manifest"]), sha256: digest,
  index: sequence, count: positiveSequence.max(32), bytes: positiveSequence.max(CLOUD_LOCAL_COMMAND_HISTORY_MANIFEST_MAX_BYTES),
  data: z.string().min(4).max(Math.ceil(CLOUD_LOCAL_COMMAND_HISTORY_PART_MAX_BYTES / 3) * 4),
}).strict().superRefine((value, context) => {
  let decoded: string;
  if (value.data.length > Math.ceil(CLOUD_LOCAL_COMMAND_HISTORY_PART_MAX_BYTES / 3) * 4) {
    context.addIssue({ code: "custom", message: "History part exceeds byte limit" }); return;
  }
  try { decoded = atob(value.data); if (btoa(decoded) !== value.data) throw new Error(); }
  catch { context.addIssue({ code: "custom", message: "History part encoding is not canonical" }); return; }
  if (value.index >= value.count || value.count !== Math.ceil(value.bytes / CLOUD_LOCAL_COMMAND_HISTORY_PART_MAX_BYTES) ||
      (value.kind === "record" && value.bytes > CLOUD_LOCAL_COMMAND_HISTORY_RECORD_MAX_BYTES) ||
      decoded.length !== Math.min(CLOUD_LOCAL_COMMAND_HISTORY_PART_MAX_BYTES, value.bytes - value.index * CLOUD_LOCAL_COMMAND_HISTORY_PART_MAX_BYTES))
    context.addIssue({ code: "custom", message: "History part bounds are inconsistent" });
});
export type CloudLocalCommandHistoryPart = z.infer<typeof CloudLocalCommandHistoryPartSchema>;
export const CloudLocalCommandHistorySchema = z.union([
  z.object({ restoreRevision: positiveSequence, recordSequence: sequence, eventSequence: sequence, manifestSha256: digest }).strict(),
  z.object({ restoreRevision: positiveSequence, recordSequence: sequence.nullable(), eventSequence: sequence.nullable(),
    incompleteReason: z.enum(["capture_unavailable", "capture_conflict", "history_limit", "recovery_uncertain"]) }).strict(),
]);
export type CloudLocalCommandHistory = z.infer<typeof CloudLocalCommandHistorySchema>;

/** Current restore authority is independent of an immutable turn receipt.
 * Incomplete edit/delete/repair heads still carry their actual source and
 * origin, so a later older complete snapshot cannot erase the mutation. */
export const CloudLocalCommandHistoryHeadSchema = z.object({
  originWriterEpoch: z.uuid(), source: CloudLocalCommandHistorySourceSchema,
  deleted: z.boolean(), history: CloudLocalCommandHistorySchema,
}).strict();
export type CloudLocalCommandHistoryHead = z.infer<typeof CloudLocalCommandHistoryHeadSchema>;

/** Structural agreement only. Consumers separately prove parent conversation,
 * authenticated boot/writer, and actual canonical bytes/digest; the supplied
 * digest must be computed from those verified bytes, never trusted from wire. */
export function cloudLocalCommandHistoryHeadMatchesManifest(
  head: CloudLocalCommandHistoryHead, manifest: CloudLocalCommandHistoryManifest, actualManifestSha256: string,
): boolean {
  return "manifestSha256" in head.history && head.history.manifestSha256 === actualManifestSha256 &&
    head.originWriterEpoch === manifest.scope.writerEpoch && head.deleted === manifest.deleted &&
    head.history.restoreRevision === manifest.restoreRevision && head.history.recordSequence === manifest.recordSequence &&
    head.history.eventSequence === manifest.eventSequence &&
    canonicalCloudLocalCommandHistoryJson(head.source) === canonicalCloudLocalCommandHistoryJson(manifest.source);
}

/** Owner identity is resolved by the engine from the real native execution
 * and request resolver. A supplied frame cannot choose its own actor/turn.
 * eventSequence is the LOCAL live-stream cursor, not compact CP row count. */
export const CloudCompactControlEventSchema = z.object({
  version: z.literal(1), eventSequence: positiveSequence, executionId: identity,
  turnId: identity.optional(), commandId: z.uuid().optional(), frame: CloudCompactControlFrameSchema,
}).strict().superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > CLOUD_COMPACT_CONTROL_MAX_BYTES)
    context.addIssue({ code: "custom", message: "Compact control exceeds byte limit" });
  if ("executionId" in value.frame && value.frame.executionId !== undefined && value.frame.executionId !== value.executionId)
    context.addIssue({ code: "custom", message: "Compact control execution is inconsistent" });
  if ("request" in value.frame && value.frame.request.executionId !== undefined && value.frame.request.executionId !== value.executionId)
    context.addIssue({ code: "custom", message: "Compact request execution is inconsistent" });
});
export type CloudCompactControlEvent = z.infer<typeof CloudCompactControlEventSchema>;

export const CloudLocalCommandMirrorChangeSchema = z.object({
  sequence: positiveSequence, conversationId: identity, revision: sequence, paused: z.boolean(),
  entry: CloudBootCommandEntrySchema.optional(), nativeGoal: CloudGoalSnapshotSchema.optional(),
  originWriterEpoch: z.uuid().optional(), actor: CloudActorProvenanceSchema.optional(),
  // Retained after payload removal, even when terminal is the first mirror.
  intent: intent.optional(),
  credentialRun: CloudAgentCredentialRunInfoSchema.optional(),
  event: CloudCompactControlEventSchema.optional(),
  historyPart: CloudLocalCommandHistoryPartSchema.optional(),
  /** recordSequence=headRev() of the LOCAL record runtime; eventSequence is
   * the local live journal head. Outbox waits for confirmedLocalHead and
   * confirmed local event head. These are never CP global revisions. */
  history: CloudLocalCommandHistorySchema.optional(),
  historyHead: CloudLocalCommandHistoryHeadSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.nativeGoal && value.nativeGoal.conversationId !== value.conversationId)
    context.addIssue({ code: "custom", message: "Mirrored goal conversation is inconsistent" });
  if (value.event && "chatId" in value.event.frame && value.event.frame.chatId !== undefined &&
      value.event.frame.chatId !== value.conversationId)
    context.addIssue({ code: "custom", message: "Compact control conversation is inconsistent" });
  if (value.entry) {
    if (!value.originWriterEpoch || !value.intent)
      context.addIssue({ code: "custom", message: "Mirrored entry requires origin writer and durable intent" });
    const pending = value.entry.state === "queued" || value.entry.state === "dispatching";
    if (pending && (!value.entry.payload || !value.actor))
      context.addIssue({ code: "custom", message: "Mirrored pending entry requires payload and verified provenance" });
    if (value.entry.payload && (value.entry.payload.userMessageId !== value.intent?.userMessageId ||
        value.entry.payload.agentId !== value.intent?.agentId))
      context.addIssue({ code: "custom", message: "Mirrored prompt intent is inconsistent" });
    if (!pending && (value.entry.payload !== null || !value.history))
      context.addIssue({ code: "custom", message: "Mirrored terminal requires payload removal and history watermark" });
    if (value.actor && value.actor.scope.writerEpoch !== value.originWriterEpoch)
      context.addIssue({ code: "custom", message: "Mirrored actor origin is inconsistent" });
    if (value.credentialRun && (value.entry.state === "queued" || value.credentialRun.provider !== value.intent?.agentId ||
        value.credentialRun.writerEpoch !== value.originWriterEpoch ||
        (value.actor && (value.credentialRun.bootId !== value.actor.scope.bootId ||
          value.credentialRun.fundingOwnerUserId !== value.actor.scope.fundingOwnerUserId ||
          value.credentialRun.fundingOwnerEpoch !== value.actor.scope.fundingOwnerEpoch))))
      context.addIssue({ code: "custom", message: "Mirrored credential dispatch binding is inconsistent" });
    const terminal = value.entry.result?.terminal;
    if (terminal && (terminal.commandId !== value.entry.commandId || terminal.conversationId !== value.conversationId ||
        terminal.executionId !== value.entry.executionId || terminal.turnId !== value.intent?.userMessageId ||
        terminal.agentId !== value.intent?.agentId))
      context.addIssue({ code: "custom", message: "Mirrored terminal identity is inconsistent" });
    if (value.event && (value.event.executionId !== value.entry.executionId ||
        (value.event.commandId !== undefined && value.event.commandId !== value.entry.commandId) ||
        (value.event.turnId !== undefined && value.event.turnId !== value.intent?.userMessageId) ||
        value.event.frame.agentId !== value.intent?.agentId))
      context.addIssue({ code: "custom", message: "Mirrored control intent is inconsistent" });
    const head = value.historyHead;
    if (head?.source.kind === "command" && (head.originWriterEpoch !== value.originWriterEpoch ||
        head.source.commandId !== value.entry.commandId || head.source.executionId !== value.entry.executionId ||
        head.source.intent.userMessageId !== value.intent?.userMessageId || head.source.intent.agentId !== value.intent?.agentId ||
        (value.history && canonicalCloudLocalCommandHistoryJson(head.history) !== canonicalCloudLocalCommandHistoryJson(value.history))))
      context.addIssue({ code: "custom", message: "Current command history head is inconsistent" });
  } else if (value.credentialRun || value.intent) {
    context.addIssue({ code: "custom", message: "Mirrored credential run and intent require an entry" });
  }
  if (!value.entry && value.history)
    context.addIssue({ code: "custom", message: "Current history without a receipt requires an explicit head" });
  if (!value.entry && value.originWriterEpoch && value.historyHead && value.originWriterEpoch !== value.historyHead.originWriterEpoch)
    context.addIssue({ code: "custom", message: "Current history origin is inconsistent" });
});
export type CloudLocalCommandMirrorChange = z.infer<typeof CloudLocalCommandMirrorChangeSchema>;

export const CloudLocalCommandMirrorBatchSchema = z.object({
  version: z.literal(1), bootId: z.uuid(), writerEpoch: z.uuid(), batchId: z.uuid(),
  after: sequence, through: sequence, changes: z.array(CloudLocalCommandMirrorChangeSchema).min(1).max(32),
}).strict().superRefine((value, context) => {
  if (value.through !== value.after + value.changes.length ||
      value.changes.some((change, index) => change.sequence !== value.after + index + 1))
    context.addIssue({ code: "custom", message: "Mirror sequence is not contiguous" });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > CLOUD_LOCAL_COMMAND_MIRROR_MAX_BYTES)
    context.addIssue({ code: "custom", message: "Mirror batch exceeds byte limit" });
  if (value.changes.some(change => change.entry &&
      (change.entry.state === "queued" || change.entry.state === "dispatching") &&
      (change.originWriterEpoch !== value.writerEpoch || change.actor?.scope.bootId !== value.bootId)))
    context.addIssue({ code: "custom", message: "Pending intent must belong to the active writer" });
});
export type CloudLocalCommandMirrorBatch = z.infer<typeof CloudLocalCommandMirrorBatchSchema>;
export const CloudLocalCommandMirrorAckSchema = z.object({
  version: z.literal(1), writerEpoch: z.uuid(), batchId: z.uuid(), through: sequence,
  /** Closed feedback for document parts supplied in this exact flight.
   * Receipts keep their original audit history; a limit publishes a separate
   * incomplete current head in the producer's FULL transaction. */
  historyLimits: z.array(z.object({ conversationId: identity, sha256: digest }).strict()).max(32)
    .refine(values => new Set(values.map(value => `${value.conversationId}\0${value.sha256}`)).size === values.length).optional(),
}).strict();
export type CloudLocalCommandMirrorAck = z.infer<typeof CloudLocalCommandMirrorAckSchema>;

/** A seal is a separate authenticated engine operation after FULL inventory
 * freeze and positive drain. Parsing this descriptor alone does not prove
 * local durability, source retirement or custody of canonical bytes. */
export const CloudLocalCommandWriterSealSchema = z.object({
  version: z.literal(1), scope: CloudAgentBootScopeSchema, sealId: z.uuid(), sequence,
  recordSequence: sequence, eventSequence: sequence, inventorySha256: digest, sha256: digest,
}).strict();
export type CloudLocalCommandWriterSeal = z.infer<typeof CloudLocalCommandWriterSealSchema>;
export const CloudLocalCommandWriterSealAckSchema = z.object({
  version: z.literal(1), sealId: z.uuid(), writerEpoch: z.uuid(), sequence,
  recordSequence: sequence, eventSequence: sequence, inventorySha256: digest, sha256: digest,
}).strict();
export type CloudLocalCommandWriterSealAck = z.infer<typeof CloudLocalCommandWriterSealAckSchema>;
const sealDescriptor = CloudLocalCommandWriterSealSchema.omit({ sha256: true });
/** Canonical wire bytes only. The engine owns and proves the separately
 * frozen private inventory; CP can bind its opaque digest without claiming
 * to reconstruct that inventory or infer native/source retirement. */
export function canonicalCloudLocalCommandWriterSealDescriptor(value: unknown): string {
  const complete = CloudLocalCommandWriterSealSchema.safeParse(value);
  if (complete.success) {
    const fields = { ...complete.data }; delete (fields as Partial<CloudLocalCommandWriterSeal>).sha256;
    return canonicalCloudLocalCommandHistoryJson(sealDescriptor.parse(fields));
  }
  return canonicalCloudLocalCommandHistoryJson(sealDescriptor.parse(value));
}
export function cloudLocalCommandWriterSealAckMatchesSeal(ack: CloudLocalCommandWriterSealAck, seal: CloudLocalCommandWriterSeal): boolean {
  return ack.version === seal.version && ack.sealId === seal.sealId && ack.writerEpoch === seal.scope.writerEpoch &&
    ack.sequence === seal.sequence && ack.recordSequence === seal.recordSequence && ack.eventSequence === seal.eventSequence &&
    ack.inventorySha256 === seal.inventorySha256 && ack.sha256 === seal.sha256;
}

/** Structural flight matching only. The caller supplies its immutable
 * durably assigned body and authenticates the boot/scope; feedback and ACK
 * must commit atomically before any unreachable part jobs are pruned. */
export function cloudLocalCommandMirrorAckMatchesBatch(ack: CloudLocalCommandMirrorAck, batch: CloudLocalCommandMirrorBatch): boolean {
  return ack.writerEpoch === batch.writerEpoch && ack.batchId === batch.batchId && ack.through === batch.through &&
    (ack.historyLimits ?? []).every(pair => batch.changes.some(change => change.conversationId === pair.conversationId &&
      change.historyPart?.sha256 === pair.sha256));
}
