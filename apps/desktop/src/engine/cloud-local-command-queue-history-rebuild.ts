import { createHash } from "node:crypto";
import path from "node:path";
import type Sqlite from "better-sqlite3";
import { z } from "zod";
import { CloudAgentBootScopeSchema, type CloudAgentBootScope } from "@zeros/protocol/cloud-agent-bootstrap";
import { canonicalCloudLocalCommandHistoryJson as canonical, canonicalCloudLocalCommandWriterSealDescriptor,
  cloudLocalCommandHistoryHeadMatchesManifest, CloudCompactControlEventSchema, CloudLocalCommandHistoryHeadSchema,
  CloudLocalCommandHistoryManifestSchema, CloudLocalCommandHistoryRecordSchema, CloudLocalCommandWriterSealSchema,
  CloudLocalCommandWriterSealAckSchema, cloudLocalCommandWriterSealAckMatchesSeal,
  CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES, CLOUD_LOCAL_COMMAND_HISTORY_RECORD_MAX_BYTES,
  CLOUD_LOCAL_COMMAND_HISTORY_MANIFEST_MAX_BYTES, type CloudLocalCommandHistoryHead,
  type CloudLocalCommandHistoryRecord, type CloudLocalCommandWriterSeal } from "@zeros/protocol/cloud-local-mirror";

const identity = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), sequence = z.number().int().safe().nonnegative();
const nullableText = z.string().nullable();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const FENCE_PREFIX = "cloud-canonical-history-rebuild-v1:";
type Row = Record<string,string | number | null>;
const chatDocument = z.object({ version: z.literal(1), chat: z.object({
  id: identity, folder: z.string(), title: z.string(), createdAt: sequence, updatedAt: sequence,
  agentId: nullableText, agentName: nullableText, model: nullableText, effort: z.string(), permissionMode: z.string(),
  fast: z.boolean(), pinned: z.boolean(), archived: z.boolean(), sourceChatId: nullableText, kind: nullableText,
  lastModeId: nullableText, prePlanModeId: nullableText, composerMode: z.enum(["code","design"]), composerModeRevision: sequence,
  additionalDirectories: z.array(z.string()).length(0), sessionId: nullableText,
  providerBinding: z.unknown(), providerMetadata: z.unknown(),
}).strict() }).strict();
const messageDocument = z.object({ version: z.literal(1), chatId: identity, msgId: identity, ord: sequence,
  kind: z.string(), payload: z.string(), createdAt: sequence }).strict();
const turnDocument = z.object({ version: z.literal(1), row: z.object({ chat_id: identity, turn_id: identity,
  workspace_id: z.null(), folder: nullableText, agent_id: nullableText, ord: sequence, summary: nullableText,
  started_at: sequence, ended_at: sequence.nullable(), stop_reason: nullableText, status: z.string().min(1).max(32),
  pre_snapshot: nullableText, post_snapshot: nullableText, files: nullableText, usage: nullableText,
}).strict() }).strict();
const fenceSchema = z.object({ version: z.literal(1), organizationId: z.uuid(), workspaceId: z.uuid(), repositoryRoot: z.string(),
  historyHead: CloudLocalCommandHistoryHeadSchema }).strict();

/** Static failure only: malformed artifacts/SQLite errors cannot disclose
 * retained content or masquerade as native/queue authority. */
export class CloudLocalCommandHistoryRebuildError extends Error {
  readonly code = "cloud_history_rebuild_refused";
  constructor() { super("cloud_history_rebuild_refused"); this.name = "CloudLocalCommandHistoryRebuildError"; }
}
export interface CloudLocalCommandHistoryRebuildInput {
  db: Sqlite.Database;
  /** W4 verifies authenticated custody, the exact sealed file pair and ACK
   * before supplying this read-only candidate. This helper never opens it. */
  ledger: Sqlite.Database;
  repositoryRoot: string;
  scope: CloudAgentBootScope;
  sourceSeal: CloudLocalCommandWriterSeal;
  conversationId: string;
}
export interface CloudLocalCommandHistoryRebuildResult {
  readonly conversationId: string;
  readonly historyHead: CloudLocalCommandHistoryHead;
  readonly restored: boolean;
}
function refuse(): never { throw new CloudLocalCommandHistoryRebuildError(); }
function folder(root: string, value: string): string {
  if (value !== "." && (path.isAbsolute(value) || value.includes("\\") || value.split("/").some(part => !part || part === "." || part === ".."))) refuse();
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) refuse();
  }
  const result = path.resolve(root,value), relative = path.relative(root,result);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) refuse();
  return result;
}
function inRoot(root: string, value: unknown): boolean {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value) return false;
  const relative = path.relative(root,value);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function compound(kind: "m" | "t" | "c", conversationId: string, id: string): string { return `${kind}:${hash(`${conversationId}\0${id}`)}`; }
function document(ledger: Sqlite.Database, sha256: string, kind: "manifest" | "record") {
  const metadata = ledger.prepare("SELECT kind,bytes,length(CAST(document AS BLOB)) AS actual FROM local_command_history_documents WHERE sha256=?")
    .get(sha256) as { kind: string; bytes: number; actual: number } | undefined;
  const max = kind === "manifest" ? CLOUD_LOCAL_COMMAND_HISTORY_MANIFEST_MAX_BYTES : CLOUD_LOCAL_COMMAND_HISTORY_RECORD_MAX_BYTES;
  if (!metadata || metadata.kind !== kind || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1 || metadata.bytes > max || metadata.bytes !== metadata.actual) refuse();
  const row = ledger.prepare("SELECT document FROM local_command_history_documents WHERE sha256=?").get(sha256) as { document: string };
  if (Buffer.byteLength(row.document) !== metadata.bytes || hash(row.document) !== sha256) refuse();
  const raw: unknown = JSON.parse(row.document);
  const parsed = kind === "manifest" ? CloudLocalCommandHistoryManifestSchema.parse(raw) : CloudLocalCommandHistoryRecordSchema.parse(raw);
  if (canonical(raw) !== row.document || canonical(parsed) !== row.document) refuse();
  return { parsed, bytes: metadata.bytes };
}
function storedSeal(ledger: Sqlite.Database, writerEpoch: string): CloudLocalCommandWriterSeal {
  const row = ledger.prepare("SELECT document,ack FROM local_command_writer_seals WHERE writer_epoch=?")
    .get(writerEpoch) as { document: string; ack: string | null } | undefined;
  if (!row || row.ack === null || Buffer.byteLength(row.document) > 64 * 1024 || Buffer.byteLength(row.ack) > 64 * 1024) refuse();
  const seal = CloudLocalCommandWriterSealSchema.parse(JSON.parse(row.document));
  const ack = CloudLocalCommandWriterSealAckSchema.parse(JSON.parse(row.ack));
  if (seal.scope.writerEpoch !== writerEpoch || canonical(seal) !== row.document || canonical(ack) !== row.ack ||
      hash(canonicalCloudLocalCommandWriterSealDescriptor(seal)) !== seal.sha256 || !cloudLocalCommandWriterSealAckMatchesSeal(ack,seal)) refuse();
  return seal;
}
function source(ledger: Sqlite.Database, conversationId: string, head: CloudLocalCommandHistoryHead, seal: CloudLocalCommandWriterSeal): CloudAgentBootScope {
  if (head.source.kind !== "command") {
    const origin = head.originWriterEpoch === seal.scope.writerEpoch ? seal : storedSeal(ledger,head.originWriterEpoch);
    if (origin.scope.organizationId !== seal.scope.organizationId || origin.scope.workspaceId !== seal.scope.workspaceId ||
        origin.scope.generation > seal.scope.generation || origin.scope.fundingOwnerEpoch > seal.scope.fundingOwnerEpoch ||
        head.history.recordSequence !== null && head.history.recordSequence > origin.recordSequence ||
        head.history.eventSequence !== null && head.history.eventSequence > origin.eventSequence) refuse();
    return origin.scope;
  }
  const row = ledger.prepare(`SELECT conversation_id,writer_epoch,generation,user_message_id,agent_id,execution_id,result,actor,state
    FROM local_commands WHERE id=?`).get(head.source.commandId) as {
      conversation_id: string; writer_epoch: string; generation: number; user_message_id: string; agent_id: string;
      execution_id: string | null; result: string | null; actor: string; state: string;
    } | undefined;
  if (!row || row.conversation_id !== conversationId || row.writer_epoch !== head.originWriterEpoch ||
      row.user_message_id !== head.source.intent.userMessageId || row.agent_id !== head.source.intent.agentId || row.execution_id !== head.source.executionId ||
      row.state === "queued" || row.state === "dispatching" ||
      (row.result === null ? null : hash(canonical(JSON.parse(row.result)))) !== head.source.nativeResultSha256) refuse();
  const actor = JSON.parse(row.actor) as { scope?: unknown }, origin = CloudAgentBootScopeSchema.parse(actor.scope);
  if (origin.writerEpoch !== head.originWriterEpoch || origin.generation !== row.generation || origin.organizationId !== seal.scope.organizationId ||
      origin.workspaceId !== seal.scope.workspaceId || origin.generation > seal.scope.generation || origin.fundingOwnerEpoch > seal.scope.fundingOwnerEpoch) refuse();
  return origin;
}
function content(payload: string): string {
  const value: unknown = JSON.parse(payload);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const object = value as Record<string,unknown>;
  return Object.hasOwn(object,"text") && typeof object.text === "string" ? object.text : Object.hasOwn(object,"title") && typeof object.title === "string" ? object.title : "";
}
function rows(db: Sqlite.Database, table: "chats" | "chat_messages" | "turns", columns: string[], conversationId: string): Row[] {
  return db.prepare(`SELECT ${columns.join(",")} FROM ${table} WHERE ${table === "chats" ? "id" : "chat_id"}=?${table === "chats" ? "" : " ORDER BY ord," + (table === "turns" ? "turn_id" : "msg_id")}`)
    .all(conversationId) as Row[];
}
function insert(db: Sqlite.Database, table: "chats" | "chat_messages" | "turns", row: Row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...Object.values(row));
}

/** Pure synchronous projection from independently verified sealed custody.
 * Reads latest FULL authority/CAS; writes only NORMAL transcript and local
 * restore fences. Native sessions, claims, permissions and queue state are
 * never reconstructed. Caller installs these fences before any exposure. */
export function rebuildCloudLocalCommandHistory(input: CloudLocalCommandHistoryRebuildInput): CloudLocalCommandHistoryRebuildResult {
  try {
    const scope = CloudAgentBootScopeSchema.parse(input.scope), seal = CloudLocalCommandWriterSealSchema.parse(input.sourceSeal);
    const conversationId = identity.parse(input.conversationId), root = input.repositoryRoot;
    if (!path.isAbsolute(root) || path.resolve(root) !== root || canonical(scope) !== canonical(seal.scope) ||
        hash(canonicalCloudLocalCommandWriterSealDescriptor(seal)) !== seal.sha256 || input.db === input.ledger) refuse();
    return input.ledger.transaction(() => {
      const metadata = (key: string) => (input.ledger.prepare("SELECT value FROM local_command_metadata WHERE key=?").get(key) as { value: string } | undefined)?.value;
      if (metadata("writer") !== canonical(scope) || metadata("sealedWriter") !== scope.writerEpoch ||
          metadata("journalHead") !== String(seal.sequence) || metadata("mirrorHead") !== String(seal.sequence)) refuse();
      if (canonical(storedSeal(input.ledger,scope.writerEpoch)) !== canonical(seal)) refuse();
      const stored = input.ledger.prepare("SELECT restore_revision,document FROM local_command_history_heads WHERE conversation_id=?")
        .get(conversationId) as { restore_revision: number; document: string } | undefined;
      if (!stored || stored.document.length > 64 * 1024) refuse();
      const head = CloudLocalCommandHistoryHeadSchema.parse(JSON.parse(stored.document));
      if (stored.restore_revision !== head.history.restoreRevision || canonical(head) !== stored.document ||
          (head.history.recordSequence !== null && head.history.recordSequence > seal.recordSequence) ||
          (head.history.eventSequence !== null && head.history.eventSequence > seal.eventSequence)) refuse();
      const origin = source(input.ledger,conversationId,head,seal);
      let chat: Row | null = null; const messages: Row[] = [], turns: Row[] = [];
      if ("manifestSha256" in head.history) {
        const artifact = document(input.ledger,head.history.manifestSha256,"manifest"), manifest = CloudLocalCommandHistoryManifestSchema.parse(artifact.parsed);
        if (manifest.conversationId !== conversationId || !cloudLocalCommandHistoryHeadMatchesManifest(head,manifest,head.history.manifestSha256) ||
            manifest.scope.organizationId !== scope.organizationId || manifest.scope.workspaceId !== scope.workspaceId ||
            manifest.scope.generation > scope.generation || manifest.scope.fundingOwnerEpoch > scope.fundingOwnerEpoch ||
            canonical(manifest.scope) !== canonical(origin)) refuse();
        let bytes = artifact.bytes; const seenMessages = new Set<string>(), seenTurns = new Set<string>();
        for (const ref of manifest.records) {
          const value = document(input.ledger,ref.sha256,"record"); bytes += value.bytes;
          if (bytes > CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES) refuse();
          const record: CloudLocalCommandHistoryRecord = CloudLocalCommandHistoryRecordSchema.parse(value.parsed);
          if (record.conversationId !== conversationId || record.entityKind !== ref.entityKind || record.entityId !== ref.entityId ||
              record.schemaVersion !== ref.schemaVersion || record.sourceRevision !== ref.sourceRevision || record.sourceRevision > manifest.recordSequence) refuse();
          if (record.entityKind === "chat") {
            const value = chatDocument.parse(record.document).chat;
            if (chat || record.entityId !== conversationId || value.id !== conversationId) refuse();
            chat = { id: conversationId, folder: folder(root,value.folder), agent_id: value.agentId, agent_name: value.agentName, model: value.model,
              effort: value.effort, permission_mode: value.permissionMode, title: value.title, created_at: value.createdAt, updated_at: value.updatedAt,
              session_id: null, provider_binding: null, provider_metadata: null, fast: Number(value.fast), pinned: Number(value.pinned), archived: Number(value.archived),
              source_chat_id: value.sourceChatId, kind: value.kind, last_mode_id: value.lastModeId, pre_plan_mode_id: value.prePlanModeId,
              composer_mode: value.composerMode, composer_mode_revision: value.composerModeRevision, rev: record.sourceRevision };
          } else if (record.entityKind === "message") {
            const value = messageDocument.parse(record.document);
            if (value.chatId !== conversationId || record.entityId !== compound("m",conversationId,value.msgId) || seenMessages.has(value.msgId)) refuse();
            seenMessages.add(value.msgId); messages.push({ chat_id: conversationId, msg_id: value.msgId, ord: value.ord, kind: value.kind,
              payload: value.payload, created_at: value.createdAt, content: content(value.payload), rev: record.sourceRevision });
          } else if (record.entityKind === "turn") {
            const value = turnDocument.parse(record.document).row;
            if (value.chat_id !== conversationId || record.entityId !== compound("t",conversationId,value.turn_id) || seenTurns.has(value.turn_id)) refuse();
            seenTurns.add(value.turn_id); turns.push({ ...value, folder: value.folder === null ? null : folder(root,value.folder), rev: record.sourceRevision });
          } else {
            const value = CloudCompactControlEventSchema.parse(record.document);
            if (value.eventSequence > manifest.eventSequence || record.entityId !== compound("c",conversationId,
                `${value.frame.cloudStream?.streamId ?? manifest.scope.engineInstanceId}:${value.eventSequence}`)) refuse();
            // Historical controls remain in verified CAS; never recreate an
            // active request/resolver or republish them as a new live event.
          }
        }
        if (manifest.tombstones.some(value => value.sourceRevision > manifest.recordSequence) ||
            (head.deleted ? chat !== null || !manifest.tombstones.some(value => value.entityKind === "chat" && value.entityId === conversationId) : chat === null)) refuse();
        if (head.source.kind === "command" && head.source.executionId !== null) {
          const command = head.source;
          if (!messages.some(value => value.msg_id === command.intent.userMessageId) || !turns.some(value => value.turn_id === command.intent.userMessageId &&
              value.agent_id === command.intent.agentId && value.status !== "running" && value.ended_at !== null)) refuse();
        }
      }
      messages.sort((a,b) => Number(a.ord) - Number(b.ord) || String(a.msg_id).localeCompare(String(b.msg_id)));
      turns.sort((a,b) => Number(a.ord) - Number(b.ord) || String(a.turn_id).localeCompare(String(b.turn_id)));
      const key = FENCE_PREFIX + hash(`${scope.organizationId}\0${scope.workspaceId}\0${conversationId}`);
      const fence = canonical({ version: 1, organizationId: scope.organizationId, workspaceId: scope.workspaceId, repositoryRoot: root, historyHead: head });
      input.db.transaction(() => {
        const previous = input.db.prepare("SELECT value,scope FROM settings WHERE key=?").get(key) as { value: string; scope: string } | undefined;
        if (previous) {
          const prior = fenceSchema.parse(JSON.parse(previous.value));
          if (previous.scope !== "local" || prior.organizationId !== scope.organizationId || prior.workspaceId !== scope.workspaceId ||
              prior.historyHead.history.restoreRevision > head.history.restoreRevision ||
              (prior.historyHead.history.restoreRevision === head.history.restoreRevision && canonical(prior.historyHead) !== canonical(head))) refuse();
        }
        const existing = input.db.prepare("SELECT folder FROM chats WHERE id=?").get(conversationId) as { folder: string | null } | undefined;
        if (existing && !inRoot(root,existing.folder)) refuse();
        if (chat) {
          const equal = canonical(rows(input.db,"chats",Object.keys(chat),conversationId)) === canonical([chat]) &&
            canonical(rows(input.db,"chat_messages",Object.keys(messages[0] ?? { chat_id: null, msg_id: null }),conversationId)) === canonical(messages) &&
            canonical(rows(input.db,"turns",Object.keys(turns[0] ?? { chat_id: null, turn_id: null }),conversationId)) === canonical(turns);
          if (!equal) {
            input.db.prepare("DELETE FROM chat_messages WHERE chat_id=?").run(conversationId);
            input.db.prepare("DELETE FROM turns WHERE chat_id=?").run(conversationId);
            input.db.prepare("DELETE FROM chats WHERE id=?").run(conversationId);
            insert(input.db,"chats",chat); for (const row of messages) insert(input.db,"chat_messages",row); for (const row of turns) insert(input.db,"turns",row);
          }
          input.db.prepare("DELETE FROM sync_tombstones WHERE id=? AND kind IN ('chat','msgreset')").run(conversationId);
        } else {
          input.db.prepare("DELETE FROM chat_messages WHERE chat_id=?").run(conversationId);
          input.db.prepare("DELETE FROM turns WHERE chat_id=?").run(conversationId);
          if (head.deleted) input.db.prepare("DELETE FROM chats WHERE id=?").run(conversationId);
          else input.db.prepare("UPDATE chats SET session_id=NULL,provider_binding=NULL,provider_metadata=NULL WHERE id=? AND (session_id IS NOT NULL OR provider_binding IS NOT NULL OR provider_metadata IS NOT NULL)").run(conversationId);
          input.db.prepare(`INSERT INTO sync_tombstones(kind,id,rev) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET rev=excluded.rev WHERE rev<excluded.rev`)
            .run(head.deleted ? "chat" : "msgreset",conversationId,seal.recordSequence);
        }
        input.db.prepare("UPDATE sync_meta SET next_rev=? WHERE id=0 AND next_rev<?").run(seal.recordSequence + 1,seal.recordSequence + 1);
        input.db.prepare(`INSERT INTO settings(key,value,scope,rev) VALUES(?,?,'local',0) ON CONFLICT(key) DO UPDATE SET value=excluded.value,scope='local'
          WHERE value<>excluded.value OR scope<>'local'`).run(key,fence);
      })();
      if (head.source.kind === "command") Object.freeze(head.source.intent);
      Object.freeze(head.source); Object.freeze(head.history); Object.freeze(head);
      return Object.freeze({ conversationId, historyHead: head, restored: chat !== null });
    })();
  } catch { throw new CloudLocalCommandHistoryRebuildError(); }
}
