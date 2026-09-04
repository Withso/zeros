import { createHash } from "node:crypto";
import path from "node:path";

import {
  bulkUpsertChats,
  coerceChatRow,
  listChats,
  type ChatRow,
} from "./db/chats";
import { openZerosDb } from "./db";
import {
  reinsertChatMessages,
  upsertChatMessagesBulk,
  type PersistedMessageRow,
} from "./db/messages";
import { headRev } from "./db/sync";
import { reinsertTurns, type TurnDbRow } from "./db/turns";
import type { CloudDurabilityAuthority } from "./cloud-durability-runtime";

const RECORD_HEAD_PATH = "/internal/v1/cloud-workspaces/engine/record/head";
const RECORD_APPEND_PATH = "/internal/v1/cloud-workspaces/engine/record/append";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ManagedKind = "chat" | "message" | "turn";
type RemoteKind =
  | "workspace"
  | ManagedKind
  | "agent_session"
  | "run"
  | "terminal"
  | "design_transaction"
  | "metadata";

type RecordEntry = {
  entityKind: RemoteKind;
  entityId: string;
  revision: number;
  schemaVersion: number;
  document: unknown;
  tombstonedAt: string | null;
};

type LocalEntity = {
  entityKind: ManagedKind;
  entityId: string;
  schemaVersion: 1;
  document: Record<string, unknown>;
};

type SyncState = {
  remoteRevision: number;
  localHeadRevision: number;
  manifestSha256: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cloud record contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) throw new Error("cloud record contains an unsupported value");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function entityKey(kind: string, id: string): string {
  return `${kind}\0${id}`;
}

function compoundId(prefix: "m" | "t", ...parts: string[]): string {
  return `${prefix}:${createHash("sha256").update(parts.join("\0"), "utf8").digest("hex")}`;
}

function natural(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function workspaceRelative(root: string, candidate: string): string | null {
  if (!path.isAbsolute(candidate)) return null;
  const relative = path.relative(root, candidate);
  if (relative === "") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function workspaceAbsolute(root: string, relative: unknown): string | null {
  if (relative === ".") return root;
  if (
    typeof relative !== "string" ||
    relative.length < 1 ||
    relative.includes("\\") ||
    relative.startsWith("/") ||
    path.posix.normalize(relative) !== relative ||
    relative.split("/").some((part) => part === ".." || part === ".")
  ) {
    return null;
  }
  const absolute = path.resolve(root, ...relative.split("/"));
  return absolute.startsWith(`${root}${path.sep}`) ? absolute : null;
}

async function boundedJson(response: Response): Promise<unknown> {
  const rawLength = response.headers.get("content-length");
  if (
    rawLength !== null &&
    (!/^(?:0|[1-9][0-9]{0,15})$/.test(rawLength) ||
      Number(rawLength) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("cloud record response is too large");
  }
  if (!response.body) throw new Error("cloud record response is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("cloud record response is too large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function parseEntry(value: unknown): RecordEntry {
  if (!isRecord(value)) throw new Error("cloud record projection is invalid");
  const kinds: readonly RemoteKind[] = [
    "workspace",
    "chat",
    "message",
    "turn",
    "agent_session",
    "run",
    "terminal",
    "design_transaction",
    "metadata",
  ];
  const revision = natural(value.revision);
  const schemaVersion = natural(value.schemaVersion);
  if (
    !kinds.includes(value.entityKind as RemoteKind) ||
    typeof value.entityId !== "string" ||
    value.entityId.length < 1 ||
    value.entityId.length > 255 ||
    revision === null ||
    schemaVersion === null ||
    schemaVersion < 1 ||
    (value.tombstonedAt !== null &&
      (typeof value.tombstonedAt !== "string" ||
        !Number.isFinite(Date.parse(value.tombstonedAt)))) ||
    (value.tombstonedAt === null && !isRecord(value.document)) ||
    (value.tombstonedAt !== null && value.document !== null)
  ) {
    throw new Error("cloud record projection is invalid");
  }
  return {
    entityKind: value.entityKind as RemoteKind,
    entityId: value.entityId,
    revision,
    schemaVersion,
    document: value.document,
    tombstonedAt: value.tombstonedAt as string | null,
  };
}

export class CloudWorkspaceRecordRuntime {
  private readonly requestFetch: typeof fetch;
  private readonly now: () => number;
  private active: Promise<void> | null = null;

  constructor(
    private readonly repositoryRoot: string,
    dependencies: { fetch?: typeof fetch; now?: () => number } = {},
  ) {
    if (!path.isAbsolute(repositoryRoot)) {
      throw new Error("cloud record repository root is invalid");
    }
    this.requestFetch = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;
  }

  /** Boot recovery runs before the remote projection exists locally. The
   * settle flag is reserved for that first, pre-readiness import; ordinary and
   * checkpoint syncs must preserve live running rows. */
  synchronize(
    authority: CloudDurabilityAuthority,
    options: { settleImportedRunningTurns?: boolean } = {},
  ): Promise<void> {
    if (this.active) return this.active;
    const settleImportedRunningAt = options.settleImportedRunningTurns
      ? this.now()
      : null;
    const task = this.run(authority, settleImportedRunningAt).finally(() => {
      if (this.active === task) this.active = null;
    });
    this.active = task;
    return task;
  }

  private endpoint(authority: CloudDurabilityAuthority, pathname: string): URL {
    const url = new URL(pathname, new URL(authority.heartbeatEndpoint).origin);
    url.searchParams.set("workspaceId", authority.workspaceId);
    url.searchParams.set("organizationId", authority.organizationId);
    url.searchParams.set("generation", String(authority.generation));
    url.searchParams.set("engineInstanceId", authority.engineInstanceId);
    return url;
  }

  private async request(
    authority: CloudDurabilityAuthority,
    url: URL,
    init: RequestInit,
  ): Promise<unknown> {
    const response = await this.requestFetch(url, {
      ...init,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${authority.heartbeatToken}`,
        "cache-control": "no-store",
        ...init.headers,
      },
    });
    const body = await boundedJson(response);
    if (!response.ok) {
      const code =
        isRecord(body) && isRecord(body.error) && typeof body.error.code === "string"
          ? body.error.code
          : "request_failed";
      const error = new Error(`cloud record request failed: ${code}`);
      error.name = code;
      throw error;
    }
    return body;
  }

  private async remoteProjection(authority: CloudDurabilityAuthority): Promise<{
    currentRevision: number;
    entries: Map<string, RecordEntry>;
  }> {
    let cursor: { entityKind: RemoteKind; entityId: string } | null = null;
    let currentRevision: number | null = null;
    const entries = new Map<string, RecordEntry>();
    for (let page = 0; page < 100_000; page += 1) {
      const url = this.endpoint(authority, RECORD_HEAD_PATH);
      url.searchParams.set("limit", "10");
      if (cursor) {
        url.searchParams.set("afterEntityKind", cursor.entityKind);
        url.searchParams.set("afterEntityId", cursor.entityId);
      }
      const raw = await this.request(authority, url, { method: "GET" });
      if (!isRecord(raw) || !Array.isArray(raw.entries)) {
        throw new Error("cloud record projection is invalid");
      }
      const revision = natural(raw.currentRevision);
      if (revision === null || (currentRevision !== null && currentRevision !== revision)) {
        throw new Error("cloud record projection changed during pagination");
      }
      currentRevision = revision;
      const pageEntries = raw.entries.map(parseEntry);
      for (const entry of pageEntries) {
        const key = entityKey(entry.entityKind, entry.entityId);
        if (entries.has(key)) throw new Error("cloud record projection repeated an entity");
        entries.set(key, entry);
      }
      if (raw.next === null) return { currentRevision, entries };
      if (
        !isRecord(raw.next) ||
        typeof raw.next.entityKind !== "string" ||
        typeof raw.next.entityId !== "string" ||
        pageEntries.length === 0
      ) {
        throw new Error("cloud record projection cursor is invalid");
      }
      const last = pageEntries.at(-1)!;
      if (
        raw.next.entityKind !== last.entityKind ||
        raw.next.entityId !== last.entityId ||
        (cursor &&
          raw.next.entityKind === cursor.entityKind &&
          raw.next.entityId === cursor.entityId)
      ) {
        throw new Error("cloud record projection cursor is invalid");
      }
      cursor = { entityKind: last.entityKind, entityId: last.entityId };
    }
    throw new Error("cloud record projection exceeded its entity bound");
  }

  private localProjection(): Map<string, LocalEntity> {
    const db = openZerosDb();
    const entities = new Map<string, LocalEntity>();
    const chats: Array<{ chat: ChatRow; folder: string }> = listChats()
      .map((chat) => ({ chat, folder: workspaceRelative(this.repositoryRoot, chat.folder) }))
      .filter((entry): entry is { chat: ChatRow; folder: string } =>
        entry.folder !== null,
      );
    const chatIds = new Set(chats.map(({ chat }) => chat.id));
    for (const { chat, folder } of chats) {
      const document = {
        version: 1,
        chat: {
          ...chat,
          folder,
          additionalDirectories: [],
        },
      } satisfies Record<string, unknown>;
      entities.set(entityKey("chat", chat.id), {
        entityKind: "chat",
        entityId: chat.id,
        schemaVersion: 1,
        document,
      });
    }
    const messages = db
      .prepare(
        `SELECT chat_id, msg_id, ord, kind, payload, created_at
         FROM chat_messages ORDER BY chat_id, ord`,
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
      if (!chatIds.has(row.chat_id)) continue;
      const entityId = compoundId("m", row.chat_id, row.msg_id);
      entities.set(entityKey("message", entityId), {
        entityKind: "message",
        entityId,
        schemaVersion: 1,
        document: {
          version: 1,
          chatId: row.chat_id,
          msgId: row.msg_id,
          ord: row.ord,
          kind: row.kind ?? "",
          payload: row.payload,
          createdAt: row.created_at,
        },
      });
    }
    const turns = db
      .prepare(
        `SELECT chat_id, turn_id, workspace_id, folder, agent_id, ord, summary,
                started_at, ended_at, stop_reason, status, pre_snapshot,
                post_snapshot, files, usage
         FROM turns ORDER BY chat_id, ord`,
      )
      .all() as Array<Omit<TurnDbRow, "rev">>;
    for (const row of turns) {
      if (!chatIds.has(row.chat_id)) continue;
      const folder = row.folder
        ? workspaceRelative(this.repositoryRoot, row.folder)
        : null;
      const entityId = compoundId("t", row.chat_id, row.turn_id);
      entities.set(entityKey("turn", entityId), {
        entityKind: "turn",
        entityId,
        schemaVersion: 1,
        document: {
          version: 1,
          row: { ...row, workspace_id: null, folder },
        },
      });
    }
    for (const entity of entities.values()) {
      if (Buffer.byteLength(canonicalJson(entity.document), "utf8") > MAX_DOCUMENT_BYTES) {
        throw new Error(`cloud record ${entity.entityKind} document is too large`);
      }
    }
    return entities;
  }

  private readState(workspaceId: string): SyncState | null {
    const row = openZerosDb()
      .prepare(
        `SELECT remote_revision, local_head_revision, manifest_sha256
         FROM cloud_record_sync_state WHERE workspace_id = ?`,
      )
      .get(workspaceId) as
      | {
          remote_revision: number;
          local_head_revision: number;
          manifest_sha256: string;
        }
      | undefined;
    return row
      ? {
          remoteRevision: row.remote_revision,
          localHeadRevision: row.local_head_revision,
          manifestSha256: row.manifest_sha256,
        }
      : null;
  }

  private writeState(
    workspaceId: string,
    remoteRevision: number,
    localHeadRevision: number,
    manifestSha256: string,
  ): void {
    openZerosDb()
      .prepare(
        `INSERT INTO cloud_record_sync_state (
           workspace_id, remote_revision, local_head_revision,
           manifest_sha256, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           remote_revision = excluded.remote_revision,
           local_head_revision = excluded.local_head_revision,
           manifest_sha256 = excluded.manifest_sha256,
           updated_at = excluded.updated_at`,
      )
      .run(workspaceId, remoteRevision, localHeadRevision, manifestSha256, Date.now());
  }

  private restoreRemote(
    remote: Map<string, RecordEntry>,
    mode: "replace" | "missing",
    settleImportedRunningAt: number | null,
  ): void {
    const db = openZerosDb();
    const existing = this.localProjection();
    const localChats = listChats();
    const projectedChatIds = new Set(
      [...existing.values()]
        .filter((entry) => entry.entityKind === "chat")
        .map((entry) => entry.entityId),
    );
    const remoteChatIds = new Set(
      [...remote.values()]
        .filter((entry) => entry.entityKind === "chat")
        .map((entry) => entry.entityId),
    );
    for (const chat of localChats) {
      if (remoteChatIds.has(chat.id) && !projectedChatIds.has(chat.id)) {
        throw new Error("cloud chat identity belongs to another repository");
      }
    }
    const ownedChatIds = new Set([...projectedChatIds, ...remoteChatIds]);
    const chatDocuments = [...remote.values()]
      .filter(
        (entry) =>
          entry.entityKind === "chat" &&
          entry.tombstonedAt === null &&
          (mode === "replace" || !existing.has(entityKey("chat", entry.entityId))),
      )
      .map((entry) => {
        if (entry.schemaVersion !== 1 || !isRecord(entry.document)) {
          throw new Error("cloud chat schema is unsupported");
        }
        if (entry.document.version !== 1) {
          throw new Error("cloud chat schema is unsupported");
        }
        const raw = entry.document.chat;
        if (!isRecord(raw)) throw new Error("cloud chat document is invalid");
        const folder = workspaceAbsolute(this.repositoryRoot, raw.folder);
        if (folder === null) throw new Error("cloud chat document is invalid");
        const chat = coerceChatRow({
          ...raw,
          folder,
          additionalDirectories: [],
        });
        if (!chat || chat.id !== entry.entityId) {
          throw new Error("cloud chat document is invalid");
        }
        return chat;
      });
    const availableChats = new Set(
      mode === "replace" ? [] : localChats.map((chat) => chat.id),
    );
    for (const chat of chatDocuments) availableChats.add(chat.id);
    const messages = new Map<string, PersistedMessageRow[]>();
    const messageOrds = new Map<string, Set<number>>();
    for (const entry of remote.values()) {
      if (
        entry.entityKind !== "message" ||
        entry.tombstonedAt !== null ||
        (mode === "missing" && existing.has(entityKey("message", entry.entityId)))
      ) {
        continue;
      }
      if (entry.schemaVersion !== 1 || !isRecord(entry.document)) {
        throw new Error("cloud message schema is unsupported");
      }
      const document = entry.document;
      if (
        document.version !== 1 ||
        typeof document.chatId !== "string" ||
        typeof document.msgId !== "string" ||
        compoundId("m", document.chatId, document.msgId) !== entry.entityId ||
        typeof document.kind !== "string" ||
        typeof document.payload !== "string" ||
        natural(document.ord) === null ||
        natural(document.createdAt) === null ||
        !availableChats.has(document.chatId)
      ) {
        throw new Error("cloud message document is invalid");
      }
      const ords = messageOrds.get(document.chatId) ?? new Set<number>();
      if (ords.has(Number(document.ord))) {
        throw new Error("cloud message document is invalid");
      }
      ords.add(Number(document.ord));
      messageOrds.set(document.chatId, ords);
      const list = messages.get(document.chatId) ?? [];
      list.push({
        msgId: document.msgId,
        ord: Number(document.ord),
        kind: document.kind,
        payload: document.payload,
        createdAt: Number(document.createdAt),
      });
      messages.set(document.chatId, list);
    }

    const turns: TurnDbRow[] = [];
    const turnOrds = new Map<string, Set<number>>();
    for (const entry of remote.values()) {
      if (
        entry.entityKind !== "turn" ||
        entry.tombstonedAt !== null ||
        (mode === "missing" && existing.has(entityKey("turn", entry.entityId)))
      ) {
        continue;
      }
      if (
        entry.schemaVersion !== 1 ||
        !isRecord(entry.document) ||
        entry.document.version !== 1 ||
        !isRecord(entry.document.row)
      ) {
        throw new Error("cloud turn schema is unsupported");
      }
      const row = entry.document.row;
      if (
        typeof row.chat_id !== "string" ||
        typeof row.turn_id !== "string" ||
        compoundId("t", row.chat_id, row.turn_id) !== entry.entityId ||
        !availableChats.has(row.chat_id) ||
        natural(row.ord) === null ||
        natural(row.started_at) === null ||
        typeof row.status !== "string" ||
        !["running", "completed", "failed", "cancelled"].includes(row.status) ||
        (row.ended_at !== null && natural(row.ended_at) === null)
      ) {
        throw new Error("cloud turn document is invalid");
      }
      const ords = turnOrds.get(row.chat_id) ?? new Set<number>();
      if (ords.has(Number(row.ord))) {
        throw new Error("cloud turn document is invalid");
      }
      ords.add(Number(row.ord));
      turnOrds.set(row.chat_id, ords);
      const folder =
        row.folder === null
          ? null
          : workspaceAbsolute(this.repositoryRoot, row.folder);
      if (row.folder !== null && folder === null) {
        throw new Error("cloud turn document is invalid");
      }
      const settleRunning =
        settleImportedRunningAt !== null && row.status === "running";
      turns.push({
        chat_id: row.chat_id,
        turn_id: row.turn_id,
        workspace_id: null,
        folder,
        agent_id: typeof row.agent_id === "string" ? row.agent_id : null,
        ord: Number(row.ord),
        summary: typeof row.summary === "string" ? row.summary : null,
        started_at: Number(row.started_at),
        // Match the existing boot janitor's serialized terminal shape. The
        // remote row cannot retain execution authority in a fresh process.
        ended_at: settleRunning
          ? settleImportedRunningAt
          : row.ended_at === null
            ? null
            : Number(row.ended_at),
        stop_reason: settleRunning
          ? null
          : typeof row.stop_reason === "string"
            ? row.stop_reason
            : null,
        status: settleRunning ? "failed" : row.status,
        pre_snapshot: null,
        post_snapshot: null,
        files: settleRunning
          ? "[]"
          : typeof row.files === "string"
            ? row.files
            : null,
        usage: settleRunning
          ? null
          : typeof row.usage === "string"
            ? row.usage
            : null,
        rev: 0,
      });
    }
    const apply = db.transaction(() => {
      if (mode === "replace") {
        const deleteTurns = db.prepare("DELETE FROM turns WHERE chat_id = ?");
        const deleteMessages = db.prepare(
          "DELETE FROM chat_messages WHERE chat_id = ?",
        );
        const deleteChat = db.prepare("DELETE FROM chats WHERE id = ?");
        const deleteTombstone = db.prepare(
          "DELETE FROM sync_tombstones WHERE kind = ? AND id = ?",
        );
        for (const chatId of ownedChatIds) {
          deleteTurns.run(chatId);
          deleteMessages.run(chatId);
          deleteChat.run(chatId);
          deleteTombstone.run("chat", chatId);
          deleteTombstone.run("msgreset", chatId);
        }
      }
      if (chatDocuments.length > 0) bulkUpsertChats(chatDocuments);
      for (const [chatId, rows] of messages) {
        rows.sort((a, b) => a.ord - b.ord || a.msgId.localeCompare(b.msgId));
        if (mode === "replace") {
          reinsertChatMessages(chatId, rows);
        } else {
          upsertChatMessagesBulk(chatId, rows);
        }
      }
      if (turns.length > 0) {
        turns.sort(
          (a, b) =>
            a.chat_id.localeCompare(b.chat_id) ||
            a.ord - b.ord ||
            a.turn_id.localeCompare(b.turn_id),
        );
        reinsertTurns(turns);
      }
    });
    apply();
  }

  private manifest(entities: Map<string, LocalEntity>): string {
    return createHash("sha256")
      .update(
        canonicalJson(
          [...entities.values()]
            .sort((a, b) => entityKey(a.entityKind, a.entityId).localeCompare(entityKey(b.entityKind, b.entityId)))
            .map((entry) => ({
              entityKind: entry.entityKind,
              entityId: entry.entityId,
              schemaVersion: entry.schemaVersion,
              document: entry.document,
            })),
        ),
      )
      .digest("hex");
  }

  private mutations(
    local: Map<string, LocalEntity>,
    remote: Map<string, RecordEntry>,
  ): Array<Omit<LocalEntity, "document"> & { operation: "upsert" | "tombstone"; document?: Record<string, unknown> }> {
    const mutations: Array<
      Omit<LocalEntity, "document"> & {
        operation: "upsert" | "tombstone";
        document?: Record<string, unknown>;
      }
    > = [];
    for (const entry of local.values()) {
      const prior = remote.get(entityKey(entry.entityKind, entry.entityId));
      if (
        prior?.tombstonedAt === null &&
        prior.schemaVersion === entry.schemaVersion &&
        canonicalJson(prior.document) === canonicalJson(entry.document)
      ) {
        continue;
      }
      mutations.push({ ...entry, operation: "upsert" });
    }
    for (const prior of remote.values()) {
      if (
        !(["chat", "message", "turn"] as RemoteKind[]).includes(prior.entityKind) ||
        prior.tombstonedAt !== null ||
        local.has(entityKey(prior.entityKind, prior.entityId))
      ) {
        continue;
      }
      mutations.push({
        entityKind: prior.entityKind as ManagedKind,
        entityId: prior.entityId,
        schemaVersion: prior.schemaVersion as 1,
        operation: "tombstone",
      });
    }
    return mutations.sort((a, b) =>
      entityKey(a.entityKind, a.entityId).localeCompare(entityKey(b.entityKind, b.entityId)),
    );
  }

  private batches<T extends object>(mutations: T[]): T[][] {
    const result: T[][] = [];
    let current: T[] = [];
    for (const mutation of mutations) {
      const next = [...current, mutation];
      if (
        current.length > 0 &&
        (next.length > 100 || Buffer.byteLength(canonicalJson(next), "utf8") > MAX_BATCH_BYTES - 64 * 1024)
      ) {
        result.push(current);
        current = [mutation];
      } else {
        current = next;
      }
      if (Buffer.byteLength(canonicalJson(current), "utf8") > MAX_BATCH_BYTES - 64 * 1024) {
        throw new Error("cloud record mutation cannot fit in one batch");
      }
    }
    if (current.length > 0) result.push(current);
    return result;
  }

  private async append(
    authority: CloudDurabilityAuthority,
    expectedRevision: number,
    mutations: ReturnType<CloudWorkspaceRecordRuntime["mutations"]>,
  ): Promise<number> {
    const occurredAt = new Date().toISOString();
    const body = {
      workspaceId: authority.workspaceId,
      organizationId: authority.organizationId,
      generation: authority.generation,
      engineInstanceId: authority.engineInstanceId,
      expectedRevision,
      mutations: mutations.map((mutation) => ({ ...mutation, occurredAt })),
    };
    const idempotencyKey = `record.sync.${createHash("sha256")
      .update(canonicalJson(body))
      .digest("hex")
      .slice(0, 48)}`;
    const raw = await this.request(
      authority,
      this.endpoint(authority, RECORD_APPEND_PATH),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, idempotencyKey }),
      },
    );
    if (!isRecord(raw) || natural(raw.currentRevision) === null) {
      throw new Error("cloud record append response is invalid");
    }
    return Number(raw.currentRevision);
  }

  private async run(
    authority: CloudDurabilityAuthority,
    settleImportedRunningAt: number | null,
  ): Promise<void> {
    if (
      !UUID_PATTERN.test(authority.workspaceId) ||
      !UUID_PATTERN.test(authority.organizationId) ||
      !UUID_PATTERN.test(authority.engineInstanceId)
    ) {
      throw new Error("cloud record authority is invalid");
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remote = await this.remoteProjection(authority);
      const state = this.readState(authority.workspaceId);
      const localBefore = this.localProjection();
      if (remote.entries.size > 0) {
        const clean =
          localBefore.size === 0 ||
          (state !== null &&
            this.manifest(localBefore) === state.manifestSha256);
        this.restoreRemote(
          remote.entries,
          clean ? "replace" : "missing",
          settleImportedRunningAt,
        );
      }
      const local = this.localProjection();
      const pending = this.mutations(local, remote.entries);
      let revision = remote.currentRevision;
      try {
        for (const batch of this.batches(pending)) {
          revision = await this.append(authority, revision, batch);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "revision_conflict") continue;
        throw error;
      }
      const settled = this.localProjection();
      const settledHead = headRev();
      if (this.manifest(local) !== this.manifest(settled)) continue;
      this.writeState(
        authority.workspaceId,
        revision,
        settledHead,
        this.manifest(settled),
      );
      return;
    }
    throw new Error("cloud record did not converge");
  }
}
