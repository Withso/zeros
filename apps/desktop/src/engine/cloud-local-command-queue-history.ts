import { createHash } from "node:crypto";
import path from "node:path";
import type Sqlite from "better-sqlite3";
import { z } from "zod";
import { CloudAgentBootScopeSchema, type CloudAgentBootScope } from "@zeros/protocol/cloud-agent-bootstrap";
import { canonicalCloudLocalCommandHistoryJson as canonical, CloudCompactControlEventSchema,
  CloudLocalCommandHistoryHeadSchema, CloudLocalCommandHistoryManifestSchema, CloudLocalCommandHistoryRecordSchema,
  CloudLocalCommandHistorySourceSchema, CloudLocalCommandHistoryPartSchema,
  CLOUD_LOCAL_COMMAND_HISTORY_RECORD_MAX_BYTES, CLOUD_LOCAL_COMMAND_HISTORY_MANIFEST_MAX_BYTES,
  CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES, CLOUD_LOCAL_COMMAND_HISTORY_PART_MAX_BYTES,
  type CloudLocalCommandHistoryHead, type CloudLocalCommandHistoryManifest, type CloudLocalCommandHistoryRecord,
  type CloudLocalCommandHistorySource, type CloudLocalCommandHistoryPart } from "@zeros/protocol/cloud-local-mirror";

const identity = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const sequence = z.number().int().safe().nonnegative();
const MAX_RECORDS = 16_384;
type JsonObject = Record<string, unknown>;
type Row = Record<string, string | number | null>;
type IncompleteReason = "capture_unavailable" | "capture_conflict" | "history_limit" | "recovery_uncertain";
class CaptureRefusal extends Error { constructor(readonly reason: IncompleteReason) { super(reason); } }

export interface CloudLocalCommandHistoryCaptureInput {
  /** Existing NORMAL source handle. This module never opens/configures it. */
  db: Sqlite.Database;
  repositoryRoot: string;
  scope: CloudAgentBootScope;
  conversationId: string;
  source: CloudLocalCommandHistorySource;
  nativeResult: unknown;
  restoreRevision: number;
  eventSequence: number;
  /** Original execution's redactor; routing/source identities are separately
   * checked after redaction. Failure never exports unfiltered artifacts. */
  redactDocument(value: unknown): unknown;
  /** Already captured exact original compact controls, never guessed from the
   * current warm execution. Normal transcript-only capture uses explicit []. */
  controls: readonly unknown[];
  previousManifest?: CloudLocalCommandHistoryManifest;
}
export interface CloudLocalCommandHistoryDocument {
  readonly kind: "record" | "manifest";
  readonly sha256: string;
  readonly canonicalDocument: string;
  readonly parts: readonly CloudLocalCommandHistoryPart[];
}
export interface CloudLocalCommandHistoryCapture {
  readonly historyHead: CloudLocalCommandHistoryHead;
  readonly nativeResult: unknown;
  readonly manifest?: CloudLocalCommandHistoryManifest;
  readonly documents: readonly CloudLocalCommandHistoryDocument[];
}

const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function immutable<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) immutable(item); Object.freeze(value); }
  return value;
}
function json(value: unknown): unknown { return JSON.parse(canonical(value)) as unknown; }
function head(db: Sqlite.Database): number {
  const value = (db.prepare("SELECT next_rev - 1 AS rev FROM sync_meta WHERE id=0").get() as { rev?: unknown } | undefined)?.rev;
  if (!sequence.safeParse(value).success) throw new CaptureRefusal("capture_unavailable");
  return value as number;
}
function revision(value: unknown, recordSequence: number): number {
  if (!sequence.safeParse(value).success || Number(value) > recordSequence) throw new CaptureRefusal("capture_conflict");
  return value as number;
}
function relative(root: string, folder: unknown): string {
  if (typeof folder !== "string" || !path.isAbsolute(folder) || path.normalize(folder) !== folder) throw new CaptureRefusal("capture_conflict");
  const value = path.relative(root, folder);
  if (value === "") return ".";
  if (value === ".." || value.startsWith(`..${path.sep}`) || path.isAbsolute(value)) throw new CaptureRefusal("capture_conflict");
  return value.split(path.sep).join("/");
}
function compound(kind: "m" | "t" | "c", conversationId: string, entityId: string): string {
  return `${kind}:${digest(`${conversationId}\0${entityId}`)}`;
}
function chatDocument(row: Row, root: string): JsonObject {
  const strings = ["agent_id", "agent_name", "model", "last_mode_id", "pre_plan_mode_id", "session_id", "source_chat_id", "kind"];
  const result: JsonObject = { id: row.id, folder: relative(root, row.folder), composerMode: row.composer_mode ?? "code",
    composerModeRevision: row.composer_mode_revision ?? 0, effort: row.effort ?? "", permissionMode: row.permission_mode ?? "",
    fast: row.fast === 1, pinned: row.pinned === 1, archived: row.archived === 1, additionalDirectories: [], title: row.title ?? "",
    createdAt: row.created_at ?? 0, updatedAt: row.updated_at ?? 0 };
  for (const key of strings) result[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] = row[key] ?? null;
  result.providerBinding = row.provider_binding === null || row.provider_binding === undefined ? null : JSON.parse(String(row.provider_binding));
  result.providerMetadata = row.provider_metadata === null || row.provider_metadata === undefined ? null : JSON.parse(String(row.provider_metadata));
  return { version: 1, chat: result };
}
function fields(value: unknown, keys: readonly string[]): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CaptureRefusal("capture_conflict");
  const object = value as JsonObject;
  return Object.fromEntries(keys.filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));
}
function documentIdentity(kind: CloudLocalCommandHistoryRecord["entityKind"], document: unknown): string {
  const object = document as JsonObject;
  if (kind === "chat") return canonical({ ...fields(object, ["version"]), chat: fields(object.chat, ["id", "folder"]) });
  if (kind === "message") return canonical(fields(object, ["version", "chatId", "msgId", "ord", "kind", "createdAt"]));
  if (kind === "turn") return canonical({ ...fields(object, ["version"]), row: fields(object.row,
    ["chat_id", "turn_id", "workspace_id", "folder", "agent_id", "ord", "started_at", "ended_at", "status"]) });
  const frame = object.frame as JsonObject;
  return canonical({ ...fields(object, ["version", "eventSequence", "executionId", "turnId", "commandId"]),
    frame: { ...fields(frame, ["id", "timestamp", "source", "agentId", "chatId", "type", "cloudStream", "permissionId", "questionId", "sessionId", "executionId"]),
      ...(Object.hasOwn(frame, "request") ? { request: fields(frame.request, ["sessionId", "executionId", "nativeRequestId", "questionId"]) } : {}) } });
}
function artifact(kind: "record" | "manifest", value: unknown): CloudLocalCommandHistoryDocument {
  const canonicalDocument = canonical(value), bytes = Buffer.from(canonicalDocument, "utf8"), sha256 = digest(canonicalDocument);
  const limit = kind === "record" ? CLOUD_LOCAL_COMMAND_HISTORY_RECORD_MAX_BYTES : CLOUD_LOCAL_COMMAND_HISTORY_MANIFEST_MAX_BYTES;
  if (bytes.length > limit) throw new CaptureRefusal("history_limit");
  const count = Math.ceil(bytes.length / CLOUD_LOCAL_COMMAND_HISTORY_PART_MAX_BYTES), parts: CloudLocalCommandHistoryPart[] = [];
  for (let index = 0; index < count; index++) parts.push(CloudLocalCommandHistoryPartSchema.parse({ version: 1, kind, sha256,
    index, count, bytes: bytes.length, data: bytes.subarray(index * CLOUD_LOCAL_COMMAND_HISTORY_PART_MAX_BYTES, (index + 1) * CLOUD_LOCAL_COMMAND_HISTORY_PART_MAX_BYTES).toString("base64") }));
  return immutable({ kind, sha256, canonicalDocument, parts });
}

/** Pure synchronous NORMAL-DB capture. The caller owns the exact trusted
 * command/actor, FULL CAS/terminal/current-head/outbox commit and rechecks the
 * source head before publication. No I/O to CP and no queue/native mutation. */
export function captureCloudLocalCommandHistory(input: CloudLocalCommandHistoryCaptureInput): CloudLocalCommandHistoryCapture {
  const scope = CloudAgentBootScopeSchema.parse(input.scope), source = CloudLocalCommandHistorySourceSchema.parse(input.source);
  const conversationId = identity.parse(input.conversationId), restoreRevision = sequence.positive().parse(input.restoreRevision);
  const eventSequence = sequence.parse(input.eventSequence);
  if (!path.isAbsolute(input.repositoryRoot) || path.resolve(input.repositoryRoot) !== input.repositoryRoot || typeof input.redactDocument !== "function")
    throw new Error("Cloud history capture scope is invalid");
  let recordSequence: number | null = null, deleted = false;
  // Capture the native result separately: a history failure must not erase or
  // rewrite an already known provider outcome.
  const nativeResult = json(input.nativeResult);
  const incomplete = (reason: IncompleteReason): CloudLocalCommandHistoryCapture => immutable({ nativeResult,
    historyHead: CloudLocalCommandHistoryHeadSchema.parse({ originWriterEpoch: scope.writerEpoch, source, deleted,
      history: { restoreRevision, recordSequence, eventSequence, incompleteReason: reason } }), documents: [] });
  try {
    recordSequence = head(input.db);
    const capturedHead = recordSequence;
    if (source.kind === "command" && source.nativeResultSha256 !== (nativeResult === null ? null : digest(canonical(nativeResult))))
      throw new CaptureRefusal("capture_conflict");
    const previous = input.previousManifest ? CloudLocalCommandHistoryManifestSchema.parse(input.previousManifest) : undefined;
    if (previous && (previous.conversationId !== conversationId || canonical(previous.scope) !== canonical(scope) ||
        previous.restoreRevision >= restoreRevision || previous.recordSequence > capturedHead)) throw new CaptureRefusal("recovery_uncertain");
    const documents: CloudLocalCommandHistoryDocument[] = [], refs: CloudLocalCommandHistoryManifest["records"] = [];
    let bundleBytes = 0;
    const add = (entityKind: CloudLocalCommandHistoryRecord["entityKind"], entityId: string, sourceRevision: number, document: unknown) => {
      if (refs.length >= MAX_RECORDS) throw new CaptureRefusal("history_limit");
      // Bound before invoking a possibly recursive redactor, then detach from
      // mutable SQLite rows and preserve inert own JSON keys exactly.
      if (Buffer.byteLength(canonical(document)) > CLOUD_LOCAL_COMMAND_HISTORY_RECORD_MAX_BYTES) throw new CaptureRefusal("history_limit");
      const redacted = json(input.redactDocument(json(document)));
      const object = redacted as JsonObject;
      if (!object || typeof object !== "object" || Array.isArray(object) ||
          (entityKind === "chat" && (object.chat as JsonObject | undefined)?.id !== conversationId) ||
          (entityKind === "message" && object.chatId !== conversationId) ||
          (entityKind === "turn" && (object.row as JsonObject | undefined)?.chat_id !== conversationId) ||
          documentIdentity(entityKind, redacted) !== documentIdentity(entityKind, document)) throw new CaptureRefusal("capture_conflict");
      const record = { version: 1 as const, conversationId, entityKind, entityId, schemaVersion: 1 as const, sourceRevision, document: redacted };
      if (Buffer.byteLength(canonical(record)) > CLOUD_LOCAL_COMMAND_HISTORY_RECORD_MAX_BYTES) throw new CaptureRefusal("history_limit");
      const valid = CloudLocalCommandHistoryRecordSchema.safeParse(record);
      if (!valid.success || canonical(valid.data) !== canonical(record)) throw new CaptureRefusal("capture_conflict");
      const value = artifact("record", valid.data); bundleBytes += Buffer.byteLength(value.canonicalDocument);
      if (bundleBytes > CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES) throw new CaptureRefusal("history_limit");
      documents.push(value); refs.push({ entityKind, entityId, schemaVersion: 1, sourceRevision, sha256: value.sha256 });
    };
    const tombstones: CloudLocalCommandHistoryManifest["tombstones"] = previous ? json(previous.tombstones) as CloudLocalCommandHistoryManifest["tombstones"] : [];
    input.db.transaction(() => {
      if (head(input.db) !== capturedHead) throw new CaptureRefusal("capture_conflict");
      const chat = input.db.prepare("SELECT * FROM chats WHERE id=?").get(conversationId) as Row | undefined;
      const tombstone = input.db.prepare("SELECT rev FROM sync_tombstones WHERE kind='chat' AND id=?").get(conversationId) as { rev: number } | undefined;
      if (!chat) {
        if (!tombstone || source.kind !== "mutation") throw new CaptureRefusal("capture_unavailable");
        deleted = true;
        const sourceRevision = revision(tombstone.rev, capturedHead);
        const previousChat = tombstones.find(value => value.entityKind === "chat" && value.entityId === conversationId);
        if (previousChat) previousChat.sourceRevision = sourceRevision; else tombstones.push({ entityKind: "chat", entityId: conversationId, sourceRevision });
      } else {
        if (tombstone) throw new CaptureRefusal("capture_conflict");
        add("chat", conversationId, revision(chat.rev, capturedHead), chatDocument(chat, input.repositoryRoot));
        const count = input.db.prepare("SELECT count(*) AS n,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM chat_messages WHERE chat_id=?")
          .get(conversationId) as { n: number; bytes: number };
        if (count.n > MAX_RECORDS - 1 || count.bytes > CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES) throw new CaptureRefusal("history_limit");
        const messages = input.db.prepare("SELECT chat_id,msg_id,ord,kind,payload,created_at,rev FROM chat_messages WHERE chat_id=? ORDER BY ord,msg_id LIMIT ?")
          .all(conversationId, MAX_RECORDS) as Row[];
        for (const row of messages) add("message", compound("m", conversationId, identity.parse(row.msg_id)), revision(row.rev, capturedHead),
          { version: 1, chatId: conversationId, msgId: row.msg_id, ord: row.ord, kind: row.kind ?? "", payload: row.payload, createdAt: row.created_at });
        const turns = input.db.prepare("SELECT * FROM turns WHERE chat_id=? ORDER BY ord,turn_id LIMIT ?").all(conversationId, MAX_RECORDS + 1) as Row[];
        if (turns.length > MAX_RECORDS) throw new CaptureRefusal("history_limit");
        if (source.kind === "command" && source.executionId !== null) {
          const turn = turns.find(row => row.turn_id === source.intent.userMessageId);
          if (!turn || turn.agent_id !== source.intent.agentId || !messages.some(row => row.msg_id === source.intent.userMessageId)) throw new CaptureRefusal("capture_conflict");
          if (turn.status === "running" || turn.ended_at === null) throw new CaptureRefusal("capture_unavailable");
        }
        for (const row of turns) {
          const sourceRevision = revision(row.rev, capturedHead);
          const { rev: _revision, ...saved } = row;
          add("turn", compound("t", conversationId, identity.parse(row.turn_id)), sourceRevision, { version: 1,
            row: { ...saved, workspace_id: null, folder: row.folder === null ? null : relative(input.repositoryRoot, row.folder) } });
        }
        for (const value of input.controls) {
          const control = CloudCompactControlEventSchema.parse(value);
          if (control.eventSequence > eventSequence || control.frame.chatId !== undefined && control.frame.chatId !== conversationId) throw new CaptureRefusal("capture_conflict");
          add("control", compound("c", conversationId, `${control.frame.cloudStream?.streamId ?? scope.engineInstanceId}:${control.eventSequence}`), capturedHead, control);
        }
      }
      if (head(input.db) !== capturedHead) throw new CaptureRefusal("capture_conflict");
    })();
    if (head(input.db) !== capturedHead) throw new CaptureRefusal("capture_conflict");
    const alive = new Set(refs.map(value => `${value.entityKind}\0${value.entityId}`));
    for (const value of previous?.records ?? []) if (!alive.has(`${value.entityKind}\0${value.entityId}`) &&
        !tombstones.some(saved => saved.entityKind === value.entityKind && saved.entityId === value.entityId))
      tombstones.push({ entityKind: value.entityKind, entityId: value.entityId, sourceRevision: capturedHead });
    const manifest = CloudLocalCommandHistoryManifestSchema.parse({ version: 1, snapshot: "full", scope, conversationId,
      restoreRevision, deleted, recordSequence: capturedHead, eventSequence, source, records: refs,
      tombstones: tombstones.filter(value => !alive.has(`${value.entityKind}\0${value.entityId}`)) });
    const manifestDocument = artifact("manifest", manifest);
    bundleBytes += Buffer.byteLength(manifestDocument.canonicalDocument);
    if (bundleBytes > CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES) throw new CaptureRefusal("history_limit");
    documents.push(manifestDocument);
    return immutable({ nativeResult, manifest, documents,
      historyHead: CloudLocalCommandHistoryHeadSchema.parse({ originWriterEpoch: scope.writerEpoch, source, deleted,
        history: { restoreRevision, recordSequence: capturedHead, eventSequence, manifestSha256: manifestDocument.sha256 } }) });
  } catch (error) { return incomplete(error instanceof CaptureRefusal ? error.reason : "capture_unavailable"); }
}
