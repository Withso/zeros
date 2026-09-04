import { createHash } from "node:crypto";
import path from "node:path";

import type Database from "better-sqlite3";

import { openZerosDb } from "./db";
import {
  bulkUpsertChats,
  coerceChatRow,
  listChats,
  type ChatRow,
} from "./db/chats";
import {
  reinsertChatMessages,
  type PersistedMessageRow,
} from "./db/messages";
import { reinsertTurns, type TurnDbRow } from "./db/turns";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECORDS = 250_000;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_TOTAL_DOCUMENT_BYTES = 512 * 1024 * 1024;

type PortableKind = "chat" | "message" | "turn";

export type CloudWorkspaceForkRecord = {
  ordinal: number;
  entityKind: PortableKind;
  entityId: string;
  operation: "upsert";
  schemaVersion: 1;
  document: Record<string, unknown>;
  occurredAt: string;
};

export type CloudWorkspaceForkRecordEvent = {
  revision: number;
  entityKind:
    | "workspace"
    | PortableKind
    | "agent_session"
    | "run"
    | "terminal"
    | "design_transaction"
    | "metadata";
  entityId: string;
  operation: "upsert" | "tombstone";
  schemaVersion: number;
  document: Record<string, unknown> | null;
  occurredAt: string;
};

/** Bind the exact file scan and portable transcript projection into the create
 * idempotency request without materializing one unbounded JSON string. */
export function cloudWorkspaceForkSnapshotSha256(
  fileFingerprint: string,
  records: readonly CloudWorkspaceForkRecord[],
): string {
  if (!/^[a-f0-9]{64}$/.test(fileFingerprint) || records.length > MAX_RECORDS) {
    throw new Error("Fork snapshot input is invalid");
  }
  const hash = createHash("sha256")
    .update("zeros-local-to-cloud-snapshot-v1\0", "utf8")
    .update(fileFingerprint, "utf8");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.ordinal !== index) {
      throw new Error("Fork record order is invalid");
    }
    hash
      .update("\0", "utf8")
      .update(record.entityKind, "utf8")
      .update("\0", "utf8")
      .update(record.entityId, "utf8")
      .update("\0", "utf8")
      .update(record.occurredAt, "utf8")
      .update("\0", "utf8")
      .update(canonicalJson(record.document), "utf8");
  }
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Fork record contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) throw new Error("Fork record contains an unsupported value");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function natural(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function relativeFolder(root: string, candidate: string): string | null {
  if (!path.isAbsolute(candidate)) return null;
  const relative = path.relative(root, candidate);
  if (relative === "") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function absoluteFolder(root: string, candidate: unknown): string | null {
  if (candidate === ".") return root;
  if (
    typeof candidate !== "string" ||
    candidate.length < 1 ||
    candidate.includes("\\") ||
    candidate.startsWith("/") ||
    path.posix.normalize(candidate) !== candidate ||
    candidate.split("/").some((component) => component === "." || component === "..")
  ) {
    return null;
  }
  const absolute = path.resolve(root, ...candidate.split("/"));
  return absolute.startsWith(`${root}${path.sep}`) ? absolute : null;
}

function compoundId(prefix: "m" | "t", ...parts: string[]): string {
  return `${prefix}:${createHash("sha256").update(parts.join("\0"), "utf8").digest("hex")}`;
}

/** A copied conversation always receives a target-workspace-owned identity.
 * Provider-native conversation ids and the source Zeros chat id can therefore
 * never become an execution route in the destination. */
export function forkedChatId(targetWorkspaceCanonicalId: string, sourceChatId: string): string {
  if (!UUID_PATTERN.test(targetWorkspaceCanonicalId) || sourceChatId.length < 1) {
    throw new Error("Fork chat identity is invalid");
  }
  return `chat_f_${createHash("sha256")
    .update("zeros-workspace-fork-chat-v1\0", "utf8")
    .update(targetWorkspaceCanonicalId.toLowerCase(), "utf8")
    .update("\0", "utf8")
    .update(sourceChatId, "utf8")
    .digest("hex")
    .slice(0, 40)}`;
}

function assertDocumentSize(document: Record<string, unknown>): void {
  if (Buffer.byteLength(canonicalJson(document), "utf8") > MAX_DOCUMENT_BYTES) {
    throw new Error("Fork record document is too large");
  }
}

function withReadSnapshot<T>(db: Database.Database, read: () => T): T {
  return db.transaction(read).deferred();
}

/** Build a point-in-time, portable transcript projection for local→cloud.
 * Only chats/messages/turns are copied. Native provider bindings, additional
 * host directories, snapshot commit ids, and running execution state are
 * deliberately stripped. */
export function exportCloudWorkspaceForkRecords(input: {
  sourceRoot: string;
  targetWorkspaceCanonicalId: string;
  occurredAt?: string;
}): CloudWorkspaceForkRecord[] {
  const root = path.resolve(input.sourceRoot);
  if (root !== input.sourceRoot || root === path.parse(root).root) {
    throw new Error("Fork source root is invalid");
  }
  if (!UUID_PATTERN.test(input.targetWorkspaceCanonicalId)) {
    throw new Error("Fork target workspace identity is invalid");
  }
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  if (
    !Number.isFinite(Date.parse(occurredAt)) ||
    new Date(occurredAt).toISOString() !== occurredAt
  ) {
    throw new Error("Fork record timestamp is invalid");
  }
  const db = openZerosDb();
  return withReadSnapshot(db, () => {
    const chats = listChats()
      .map((chat) => ({ chat, folder: relativeFolder(root, chat.folder) }))
      .filter((entry): entry is { chat: ChatRow; folder: string } => entry.folder !== null)
      .sort((left, right) => left.chat.id.localeCompare(right.chat.id));
    const sourceChatIds = new Set(chats.map(({ chat }) => chat.id));
    const chatIdMap = new Map(
      chats.map(({ chat }) => [
        chat.id,
        forkedChatId(input.targetWorkspaceCanonicalId, chat.id),
      ]),
    );
    const records: CloudWorkspaceForkRecord[] = [];
    let totalDocumentBytes = 0;
    const append = (
      entityKind: PortableKind,
      entityId: string,
      document: Record<string, unknown>,
    ) => {
      assertDocumentSize(document);
      totalDocumentBytes += Buffer.byteLength(canonicalJson(document), "utf8");
      if (totalDocumentBytes > MAX_TOTAL_DOCUMENT_BYTES) {
        throw new Error("Fork record data is too large");
      }
      if (records.length >= MAX_RECORDS) throw new Error("Fork record count is too large");
      records.push({
        ordinal: records.length,
        entityKind,
        entityId,
        operation: "upsert",
        schemaVersion: 1,
        document,
        occurredAt,
      });
    };

    for (const { chat, folder } of chats) {
      const targetChatId = chatIdMap.get(chat.id)!;
      append("chat", targetChatId, {
        version: 1,
        chat: {
          ...chat,
          id: targetChatId,
          folder,
          additionalDirectories: [],
          sessionId: null,
          providerBinding: null,
          providerMetadata: null,
          sourceChatId: chat.id,
        },
      });
    }

    const messages = db
      .prepare(
        `SELECT chat_id, msg_id, ord, kind, payload, created_at
         FROM chat_messages ORDER BY chat_id, ord, msg_id`,
      )
      .all() as Array<{
        chat_id: string;
        msg_id: string;
        ord: number;
        kind: string | null;
        payload: string;
        created_at: number;
      }>;
    for (const row of messages) {
      if (!sourceChatIds.has(row.chat_id)) continue;
      const targetChatId = chatIdMap.get(row.chat_id)!;
      append("message", compoundId("m", targetChatId, row.msg_id), {
        version: 1,
        chatId: targetChatId,
        msgId: row.msg_id,
        ord: row.ord,
        kind: row.kind ?? "",
        payload: row.payload,
        createdAt: row.created_at,
      });
    }

    const turns = db
      .prepare(
        `SELECT chat_id, turn_id, workspace_id, folder, agent_id, ord, summary,
                started_at, ended_at, stop_reason, status, pre_snapshot,
                post_snapshot, files, usage
         FROM turns ORDER BY chat_id, ord, turn_id`,
      )
      .all() as Array<Omit<TurnDbRow, "rev">>;
    for (const row of turns) {
      if (!sourceChatIds.has(row.chat_id)) continue;
      const targetChatId = chatIdMap.get(row.chat_id)!;
      const folder = row.folder === null ? null : relativeFolder(root, row.folder);
      if (row.folder !== null && folder === null) {
        throw new Error("Fork turn folder escapes its source workspace");
      }
      const wasRunning = row.status === "running";
      append("turn", compoundId("t", targetChatId, row.turn_id), {
        version: 1,
        row: {
          ...row,
          chat_id: targetChatId,
          workspace_id: null,
          folder,
          status: wasRunning ? "cancelled" : row.status,
          ended_at: wasRunning
            ? Math.max(row.started_at, Date.parse(occurredAt))
            : row.ended_at,
          stop_reason: wasRunning ? "workspace_forked" : row.stop_reason,
          pre_snapshot: null,
          post_snapshot: null,
        },
      });
    }
    return records;
  });
}

type ParsedForkProjection = {
  chats: ChatRow[];
  messages: Map<string, PersistedMessageRow[]>;
  turns: TurnDbRow[];
};

function latestPortableEvents(events: readonly CloudWorkspaceForkRecordEvent[]) {
  if (events.length > MAX_RECORDS) throw new Error("Fork record count is too large");
  const latest = new Map<string, CloudWorkspaceForkRecordEvent>();
  let priorRevision = -1;
  let totalDocumentBytes = 0;
  for (const event of events) {
    if (
      !Number.isSafeInteger(event.revision) ||
      event.revision < 0 ||
      event.revision <= priorRevision ||
      event.entityId.length < 1 ||
      Buffer.byteLength(event.entityId, "utf8") > 255 ||
      !Number.isFinite(Date.parse(event.occurredAt)) ||
      new Date(event.occurredAt).toISOString() !== event.occurredAt ||
      !Number.isSafeInteger(event.schemaVersion) ||
      event.schemaVersion < 1 ||
      (event.operation === "upsert") !== (event.document !== null)
    ) {
      throw new Error("Fork record event stream is invalid");
    }
    priorRevision = event.revision;
    if (!["chat", "message", "turn"].includes(event.entityKind)) continue;
    if (event.document) {
      assertDocumentSize(event.document);
      totalDocumentBytes += Buffer.byteLength(canonicalJson(event.document), "utf8");
      if (totalDocumentBytes > MAX_TOTAL_DOCUMENT_BYTES) {
        throw new Error("Fork record data is too large");
      }
    }
    latest.set(`${event.entityKind}\0${event.entityId}`, event);
  }
  return [...latest.values()].filter((event) => event.operation === "upsert");
}

function parseForkProjection(input: {
  targetRoot: string;
  targetWorkspaceId: string;
  targetWorkspaceCanonicalId: string;
  events: readonly CloudWorkspaceForkRecordEvent[];
}): ParsedForkProjection {
  const targetRoot = path.resolve(input.targetRoot);
  if (
    targetRoot !== input.targetRoot ||
    targetRoot === path.parse(targetRoot).root ||
    !UUID_PATTERN.test(input.targetWorkspaceCanonicalId)
  ) {
    throw new Error("Fork import target is invalid");
  }
  const events = latestPortableEvents(input.events);
  const sourceToTarget = new Map<string, string>();
  const chats: ChatRow[] = [];
  for (const event of events) {
    if (event.entityKind !== "chat" || event.schemaVersion !== 1 || !event.document) {
      continue;
    }
    if (event.document.version !== 1 || !isRecord(event.document.chat)) {
      throw new Error("Fork chat document is invalid");
    }
    const raw = event.document.chat;
    if (typeof raw.id !== "string" || raw.id !== event.entityId) {
      throw new Error("Fork chat document is invalid");
    }
    const sourceChatId = raw.id;
    const targetChatId = forkedChatId(input.targetWorkspaceCanonicalId, sourceChatId);
    const folder = absoluteFolder(targetRoot, raw.folder);
    if (!folder) throw new Error("Fork chat folder is invalid");
    const chat = coerceChatRow({
      ...raw,
      id: targetChatId,
      folder,
      additionalDirectories: [],
      sessionId: null,
      providerBinding: null,
      providerMetadata: null,
      sourceChatId,
    });
    if (!chat || chat.id !== targetChatId) throw new Error("Fork chat document is invalid");
    sourceToTarget.set(sourceChatId, targetChatId);
    chats.push(chat);
  }

  const messages = new Map<string, PersistedMessageRow[]>();
  const messageOrds = new Map<string, Set<number>>();
  const turns: TurnDbRow[] = [];
  const turnOrds = new Map<string, Set<number>>();
  for (const event of events) {
    if (!event.document || event.schemaVersion !== 1) continue;
    if (event.entityKind === "message") {
      const document = event.document;
      const sourceChatId = document.chatId;
      const targetChatId =
        typeof sourceChatId === "string" ? sourceToTarget.get(sourceChatId) : undefined;
      if (
        document.version !== 1 ||
        typeof sourceChatId !== "string" ||
        typeof document.msgId !== "string" ||
        compoundId("m", sourceChatId, document.msgId) !== event.entityId ||
        !targetChatId ||
        natural(document.ord) === null ||
        typeof document.kind !== "string" ||
        typeof document.payload !== "string" ||
        natural(document.createdAt) === null
      ) {
        throw new Error("Fork message document is invalid");
      }
      const ords = messageOrds.get(targetChatId) ?? new Set<number>();
      if (ords.has(Number(document.ord))) throw new Error("Fork message order is invalid");
      ords.add(Number(document.ord));
      messageOrds.set(targetChatId, ords);
      const rows = messages.get(targetChatId) ?? [];
      rows.push({
        msgId: document.msgId,
        ord: Number(document.ord),
        kind: document.kind,
        payload: document.payload,
        createdAt: Number(document.createdAt),
      });
      messages.set(targetChatId, rows);
      continue;
    }
    if (event.entityKind !== "turn") continue;
    const document = event.document;
    if (document.version !== 1 || !isRecord(document.row)) {
      throw new Error("Fork turn document is invalid");
    }
    const row = document.row;
    const sourceChatId = row.chat_id;
    const targetChatId =
      typeof sourceChatId === "string" ? sourceToTarget.get(sourceChatId) : undefined;
    if (
      typeof sourceChatId !== "string" ||
      typeof row.turn_id !== "string" ||
      compoundId("t", sourceChatId, row.turn_id) !== event.entityId ||
      !targetChatId ||
      natural(row.ord) === null ||
      natural(row.started_at) === null ||
      typeof row.status !== "string" ||
      !["running", "completed", "failed", "cancelled"].includes(row.status) ||
      (row.ended_at !== null && natural(row.ended_at) === null)
    ) {
      throw new Error("Fork turn document is invalid");
    }
    const folder = row.folder === null ? null : absoluteFolder(targetRoot, row.folder);
    if (row.folder !== null && !folder) throw new Error("Fork turn folder is invalid");
    const ords = turnOrds.get(targetChatId) ?? new Set<number>();
    if (ords.has(Number(row.ord))) throw new Error("Fork turn order is invalid");
    ords.add(Number(row.ord));
    turnOrds.set(targetChatId, ords);
    const wasRunning = row.status === "running";
    turns.push({
      chat_id: targetChatId,
      turn_id: row.turn_id,
      workspace_id: input.targetWorkspaceId,
      folder,
      agent_id: typeof row.agent_id === "string" ? row.agent_id : null,
      ord: Number(row.ord),
      summary: typeof row.summary === "string" ? row.summary : null,
      started_at: Number(row.started_at),
      ended_at: wasRunning
        ? Math.max(Number(row.started_at), Date.now())
        : row.ended_at === null
          ? null
          : Number(row.ended_at),
      stop_reason: wasRunning
        ? "workspace_forked"
        : typeof row.stop_reason === "string"
          ? row.stop_reason
          : null,
      status: wasRunning ? "cancelled" : row.status,
      pre_snapshot: null,
      post_snapshot: null,
      files: typeof row.files === "string" ? row.files : null,
      usage: typeof row.usage === "string" ? row.usage : null,
      rev: 0,
    });
  }
  return { chats, messages, turns };
}

/** Import a cloud transcript into a newly created local workspace. The source
 * event stream is treated as untrusted: non-portable runtime records are
 * ignored, references are verified, ids are remapped deterministically, and
 * every provider/session/snapshot execution locator is removed. */
export function importCloudWorkspaceForkRecords(input: {
  targetRoot: string;
  targetWorkspaceId: string;
  targetWorkspaceCanonicalId: string;
  events: readonly CloudWorkspaceForkRecordEvent[];
}): { chats: number; messages: number; turns: number } {
  const projection = parseForkProjection(input);
  const db = openZerosDb();
  const importedChatIds = new Set(projection.chats.map((chat) => chat.id));
  const transaction = db.transaction(() => {
    for (const chat of projection.chats) {
      const existing = db
        .prepare("SELECT folder, source_chat_id FROM chats WHERE id = ?")
        .get(chat.id) as { folder: string | null; source_chat_id: string | null } | undefined;
      if (
        existing &&
        (existing.folder !== chat.folder || existing.source_chat_id !== chat.sourceChatId)
      ) {
        throw new Error("Fork chat identity collides with an existing conversation");
      }
    }
    bulkUpsertChats(projection.chats);
    for (const [chatId, rows] of projection.messages) {
      if (!importedChatIds.has(chatId)) throw new Error("Fork message owner is invalid");
      rows.sort((a, b) => a.ord - b.ord || a.msgId.localeCompare(b.msgId));
      reinsertChatMessages(chatId, rows);
    }
    projection.turns.sort(
      (a, b) =>
        a.chat_id.localeCompare(b.chat_id) ||
        a.ord - b.ord ||
        a.turn_id.localeCompare(b.turn_id),
    );
    reinsertTurns(projection.turns);
  });
  transaction();
  return {
    chats: projection.chats.length,
    messages: [...projection.messages.values()].reduce((sum, rows) => sum + rows.length, 0),
    turns: projection.turns.length,
  };
}
