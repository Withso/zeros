import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import {
  CloudCacheDeltaSchema, CloudCachePendingSchema, CloudCacheRangeSchema, CloudCacheMessageSchema, CloudCacheTargetSchema,
  cloudCacheKey, type CloudCacheDelta, type CloudCacheKey, type CloudCachePending, type CloudCacheRange, type CloudCacheRow, type CloudCacheTarget,
} from "../../shared/cloud-chat-cache";

const VERSION = 1, APPLICATION = 0x5a434143;
const DEFAULT_LIMITS = { channelBytes: 2 * 1024 ** 3, chatBytes: 64 * 1024 ** 2, chatRows: 50_000 };
const unavailable = () => new Error("Cloud chat cache unavailable.");
const corrupt = (error: unknown) => ["SQLITE_CORRUPT", "SQLITE_NOTADB"].includes((error as { code?: string })?.code ?? "");
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const encoded = (value: unknown): string | null => value === undefined ? null : JSON.stringify(value);
const sessionDigest = (session: string): string => createHash("sha256").update(session).digest("hex");
const SCHEMA = `
  CREATE TABLE accounts (owner TEXT PRIMARY KEY, session TEXT NOT NULL);
  CREATE TABLE chats (
    key TEXT PRIMARY KEY, owner TEXT NOT NULL, organization TEXT NOT NULL, workspace TEXT NOT NULL, chat TEXT NOT NULL,
    revision INTEGER NOT NULL, message_count INTEGER NOT NULL, history_state TEXT, queue_revision INTEGER, queue_epoch TEXT,
    last_read INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX chats_owner ON chats(owner, organization, workspace);
  CREATE INDEX chats_lru ON chats(last_read);
  CREATE TABLE messages (
    chat_key TEXT NOT NULL REFERENCES chats(key) ON DELETE CASCADE, idx INTEGER NOT NULL, msg_id TEXT NOT NULL,
    kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, bytes INTEGER NOT NULL, user_prompt INTEGER NOT NULL,
    steered INTEGER NOT NULL,
    PRIMARY KEY(chat_key,idx), UNIQUE(chat_key,msg_id)
  );
  CREATE TABLE senders (
    chat_key TEXT NOT NULL REFERENCES chats(key) ON DELETE CASCADE, msg_id TEXT NOT NULL, sender TEXT NOT NULL,
    PRIMARY KEY(chat_key,msg_id)
  );
  CREATE TABLE segments (
    chat_key TEXT NOT NULL REFERENCES chats(key) ON DELETE CASCADE, start_index INTEGER NOT NULL,
    end_index INTEGER NOT NULL, opening TEXT, PRIMARY KEY(chat_key,start_index)
  );
  CREATE TABLE pending (
    chat_key TEXT NOT NULL REFERENCES chats(key) ON DELETE CASCADE, user_message_id TEXT NOT NULL,
    epoch TEXT NOT NULL, state TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL, bytes INTEGER NOT NULL,
    PRIMARY KEY(chat_key,user_message_id)
  );
`;
const schemaText = (statements: string[]): string => JSON.stringify(statements.map(sql => sql.trim().replace(/\s+/g, " ")).filter(Boolean).sort());
const expectedSchema = schemaText(SCHEMA.split(";"));
type Chat = { revision: number; message_count: number; history_state: string | null; queue_revision: number | null; queue_epoch: string | null; last_read: number };
type Segment = { start_index: number; end_index: number; opening: string | null };
type Message = { idx: number; msg_id: string; kind: string; payload: string; created_at: number; bytes: number; user_prompt: number; steered: number };
const SenderSchema = z.union([z.object({ userId: z.string().uuid() }).transform(({ userId }) => ({ userId })), z.null()]);
/** A user message's sender as stored: '{"userId":…}' or 'null' (a known-unknown legacy attribution); no row means
 * never answered. A stored sender never changes. */
const storedSender = (senders: Record<string, unknown> | undefined, msgId: string): string | null => {
  if (!senders || !Object.hasOwn(senders, msgId)) return null;
  const parsed = SenderSchema.safeParse(senders[msgId]);
  return parsed.success ? JSON.stringify(parsed.data) : null;
};
/** The control plane's rule (history.ts isUserMessage): a text row whose payload's role is user. A minimal payload
 * without its own `kind` still counts. `steered` is a user row carrying a steeredTurnId. */
const promptKind = (kind: string, payload: string): { user: boolean; steered: boolean } => {
  if (kind !== "text") return { user: false, steered: false };
  try { const value = JSON.parse(payload); const user = value?.role === "user"; return { user, steered: user && value.steeredTurnId != null }; }
  catch { return { user: false, steered: false }; }
};
const userPrompt = (kind: string, payload: string): boolean => promptKind(kind, payload).user;
const native = (row: Message): CloudCacheRow => ({ index: row.idx, msgId: row.msg_id, kind: row.kind, payload: row.payload, createdAt: row.created_at });
/** How many of this process's descriptors are open on `file`'s inode, or null where the platform cannot list them
 * (the open is then refused rather than trusted). */
function heldDescriptors(file: fs.Stats): number | null {
  for (const root of process.platform === "linux" ? ["/proc/self/fd", "/dev/fd"] : ["/dev/fd", "/proc/self/fd"]) {
    let entries: string[];
    try { entries = fs.readdirSync(root); } catch { continue; }
    let count = 0;
    for (const entry of entries) {
      const fd = Number(entry);
      if (!Number.isInteger(fd)) continue;
      try { const info = fs.fstatSync(fd); if (info.dev === file.dev && info.ino === file.ino) count++; } catch { /* closed meanwhile */ }
    }
    return count;
  }
  return null;
}
class Capacity extends Error {}
class Incompatible extends Error {}

export class CloudChatCacheStore {
  private db?: Database.Database;
  private descriptor?: number;
  private file?: fs.Stats;
  private readonly filename: string;
  private readonly limits: typeof DEFAULT_LIMITS;
  private readonly now: () => number;
  private closed = false;
  private readonly openChats = new Map<string, string>();
  private readonly recency = new Map<string, number>();

  private readonly openNative: (filename: string) => Database.Database;

  constructor(directory: string, options: { limits?: Partial<typeof DEFAULT_LIMITS>; now?: () => number;
    /** Test seam for the native open; production opens the pathname with a 500 ms busy timeout. */
    openNative?: (filename: string) => Database.Database } = {}) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.filename = path.join(fs.realpathSync(directory), "cloud-cache.db");
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw unavailable();
    this.now = options.now ?? Date.now;
    this.openNative = options.openNative ?? (filename => new Database(filename, { timeout: 500 }));
  }

  private checkFiles(): void {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        const info = fs.lstatSync(this.filename + suffix);
        if (!info.isFile() || info.nlink !== 1 || suffix === "" && this.file &&
          (this.file.dev !== info.dev || this.file.ino !== info.ino)) throw Object.assign(unavailable(), { stage: "store_files" });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  private database(): Database.Database {
    if (this.closed) throw unavailable();
    this.checkFiles();
    if (this.db) return this.db;
    this.descriptor = fs.openSync(this.filename, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    try {
      this.file = fs.fstatSync(this.descriptor);
      if (!this.file.isFile() || this.file.nlink !== 1) throw unavailable();
      this.checkFiles();
      // SQLite opens by pathname. Bind it to the held original: the native open must add a descriptor on the custody
      // inode; a pathname swapped (and restored) around the open adds none, and the open is refused.
      const before = heldDescriptors(this.file);
      this.db = this.openNative(this.filename);
      const after = heldDescriptors(this.file);
      if (before === null || after === null || after <= before) throw Object.assign(unavailable(), { stage: "store_bind" });
      this.checkFiles();
      this.db.pragma("trusted_schema=OFF");
      const version = this.db.pragma("user_version", { simple: true });
      const app = this.db.pragma("application_id", { simple: true });
      const schema = this.db.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL").all() as Array<{ sql: string }>;
      if (version === 0 ? app !== 0 || schema.length !== 0 :
        version !== VERSION || app !== APPLICATION || schemaText(schema.map(row => row.sql)) !== expectedSchema) throw new Incompatible();
      this.db.pragma("journal_mode=WAL");
      this.db.pragma("synchronous=NORMAL");
      this.db.pragma("foreign_keys=ON");
      this.db.pragma("journal_size_limit=8388608");
      this.db.pragma("wal_autocheckpoint=256");
      this.db.pragma(`max_page_count=${Math.max(32, Math.floor(this.limits.channelBytes / 4096))}`);
      if (version === 0) this.db.transaction(() => {
        this.db!.exec(SCHEMA);
        this.db!.pragma(`application_id=${APPLICATION}`); this.db!.pragma(`user_version=${VERSION}`);
      }).immediate();
      fs.fchmodSync(this.descriptor, 0o600);
      return this.db;
    } catch (error) {
      this.db?.close(); this.db = undefined;
      if (corrupt(error) || error instanceof Incompatible) {
        this.checkFiles();
        fs.ftruncateSync(this.descriptor, 0);
        for (const suffix of ["-wal", "-shm", "-journal"]) fs.rmSync(this.filename + suffix, { force: true });
        fs.closeSync(this.descriptor); this.descriptor = undefined; this.file = undefined;
        return this.database();
      }
      fs.closeSync(this.descriptor); this.descriptor = undefined; this.file = undefined;
      throw Object.assign(unavailable(), { stage: (error as { stage?: string })?.stage ?? "store_open" });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db?.close(); this.db = undefined;
    // Closing another descriptor to this inode can release SQLite's process locks.
    if (this.descriptor !== undefined) fs.closeSync(this.descriptor);
    this.descriptor = undefined; this.file = undefined;
  }

  protect(window: string, key: CloudCacheKey | null): void {
    if (key) this.openChats.set(window, cloudCacheKey(key)); else this.openChats.delete(window);
  }
  bindAccount(owner: string, session: string): void {
    if (!owner || owner.length > 2048 || !session || session.length > 2048) throw unavailable();
    const digest = sessionDigest(session), db = this.database();
    const lookup = () => (db.prepare("SELECT session FROM accounts WHERE owner=?").get(owner) as { session: string } | undefined)?.session;
    if (lookup() === digest) return;
    if (!this.transaction(() => {
      if (lookup() === digest) return;
      db.prepare("DELETE FROM chats WHERE owner=?").run(owner);
      db.prepare("INSERT INTO accounts VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET session=excluded.session").run(owner, digest);
    })) throw unavailable();
  }
  metadata(input: CloudCacheKey): { revision: number; messageCount: number } | null {
    const chat = this.chat(cloudCacheKey(input));
    return chat ? { revision: chat.revision, messageCount: chat.message_count } : null;
  }
  cursorIndex(input: CloudCacheKey, before: string): number | null {
    const cursor = this.database().prepare("SELECT idx FROM messages WHERE chat_key=? AND msg_id=?").get(cloudCacheKey(input), before) as { idx: number } | undefined;
    return cursor?.idx ?? null;
  }
  private chat(key: string): Chat | undefined { return this.database().prepare("SELECT * FROM chats WHERE key=?").get(key) as Chat | undefined; }
  private segments(key: string): Segment[] { return this.database().prepare("SELECT start_index,end_index,opening FROM segments WHERE chat_key=? ORDER BY start_index").all(key) as Segment[]; }
  /** Inside a write transaction: persist the read recency gathered since the last mutation (eviction orders by it). */
  private flushRecency(): void {
    if (!this.recency.size) return;
    const update = this.database().prepare("UPDATE chats SET last_read=max(last_read,?) WHERE key=?");
    for (const [key, at] of this.recency) update.run(at, key);
    this.recency.clear();
  }

  private transaction(work: () => void, preserve?: string): boolean {
    const db = this.database();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        db.transaction(() => { this.flushRecency(); work(); }).immediate();
        db.pragma("wal_checkpoint(TRUNCATE)");
        return true;
      } catch (error) {
        if (error instanceof Capacity) return false;
        if ((error as { code?: string }).code !== "SQLITE_FULL") throw error;
        if (!preserve || attempt > 0 || !this.reclaim(preserve)) return false;
      }
    }
    return false;
  }

  private reclaim(preserve: string): boolean {
    // SQLite's page overhead can fill the file before the payload budget does.
    const db = this.database(), protectedKeys = new Set([...this.openChats.values(), preserve]);
    let freed = 0;
    db.transaction(() => {
      this.flushRecency();
      const ordered = db.prepare("SELECT key,bytes FROM chats ORDER BY last_read,key").all() as Array<{ key: string; bytes: number }>;
      for (const chat of ordered) {
        if (protectedKeys.has(chat.key)) continue;
        db.prepare("DELETE FROM chats WHERE key=?").run(chat.key);
        freed += chat.bytes;
        if (freed >= this.limits.chatBytes * 2) break;
      }
    }).immediate();
    db.pragma("wal_checkpoint(TRUNCATE)");
    return freed > 0;
  }

  /** Team sharing: keep the senders a reply delivered for its user rows (and its turn opening). A reply without
   * senders (N-1, or not shared) keeps what is known. */
  private putSenders(key: string, messages: Array<{ msgId: string; kind: string; payload: string }>, senders?: Record<string, unknown>): void {
    if (!senders) return;
    const statement = this.database().prepare("INSERT INTO senders VALUES (?,?,?) ON CONFLICT(chat_key,msg_id) DO NOTHING");
    for (const message of messages) {
      const sender = userPrompt(message.kind, message.payload) ? storedSender(senders, message.msgId) : null;
      if (sender !== null) statement.run(key, message.msgId, sender);
    }
  }

  private upsertRows(key: string, rows: CloudCacheRow[]): void {
    const statement = this.database().prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_key,idx) DO UPDATE SET
      msg_id=excluded.msg_id,kind=excluded.kind,payload=excluded.payload,created_at=excluded.created_at,bytes=excluded.bytes,
      user_prompt=excluded.user_prompt,steered=excluded.steered`);
    for (const row of rows) {
      const size = bytes(row.payload) + bytes(row.msgId) + bytes(row.kind) + 64;
      if (size > this.limits.chatBytes) throw new Capacity();
      // Opaque malformed native payloads are not user prompts here; presentation refuses them.
      const { user, steered } = promptKind(row.kind, row.payload);
      statement.run(key, row.index, row.msgId, row.kind, row.payload, row.createdAt, size, Number(user), Number(steered));
    }
  }

  /** The control plane's opening rule: the nearest unsteered user before the range, else the nearest user. The
   * segment's server-delivered opening precedes every cached row, so it ranks after a cached unsteered candidate. */
  private opening(key: string, from: number, segment: Segment): string | null {
    const nearest = (steered: boolean) => this.database().prepare(
      `SELECT * FROM messages WHERE chat_key=? AND idx>=? AND idx<? AND user_prompt=1${steered ? "" : " AND steered=0"} ORDER BY idx DESC LIMIT 1`,
    ).get(key, segment.start_index, from) as Message | undefined;
    const unsteered = nearest(false);
    if (unsteered) return JSON.stringify(native(unsteered));
    const delivered = segment.opening ? (() => { try { const value = JSON.parse(segment.opening!) as { kind: string; payload: string };
      return promptKind(value.kind, value.payload); } catch { return undefined; } })() : undefined;
    if (delivered?.user && !delivered.steered) return segment.opening;
    const steered = nearest(true);
    return steered ? JSON.stringify(native(steered)) : segment.opening;
  }

  private rebuildSegments(key: string, previous: Segment[]): void {
    const db = this.database();
    const indices = db.prepare("SELECT idx FROM messages WHERE chat_key=? ORDER BY idx").all(key) as Array<{ idx: number }>;
    db.prepare("DELETE FROM segments WHERE chat_key=?").run(key);
    const next: Segment[] = [];
    for (const { idx } of indices) {
      const last = next.at(-1);
      if (last && last.end_index === idx) last.end_index++;
      else next.push({ start_index: idx, end_index: idx + 1,
        opening: previous.find(segment => segment.start_index <= idx && segment.end_index > idx)?.opening ?? null });
    }
    for (const segment of next) db.prepare("INSERT INTO segments VALUES (?,?,?,?)").run(key, segment.start_index, segment.end_index, segment.opening);
    // Senders live only as long as a cached row or turn opening they attribute.
    db.prepare(`DELETE FROM senders WHERE chat_key=@key AND msg_id NOT IN (SELECT msg_id FROM messages WHERE chat_key=@key)
      AND msg_id NOT IN (SELECT json_extract(opening,'$.msgId') FROM segments WHERE chat_key=@key AND opening IS NOT NULL)`).run({ key });
  }

  private measure(key: string): number {
    const db = this.database(), chat = this.chat(key);
    if (!chat) return 0;
    const sum = (table: "messages" | "pending") => Number((db.prepare(`SELECT coalesce(sum(bytes),0) AS bytes FROM ${table} WHERE chat_key=?`).get(key) as { bytes: number }).bytes);
    const senders = Number((db.prepare("SELECT coalesce(sum(length(msg_id)+length(sender)+32),0) AS bytes FROM senders WHERE chat_key=?").get(key) as { bytes: number }).bytes);
    return bytes(key) + 128 + (chat.history_state ? bytes(chat.history_state) : 0) + sum("messages") + sum("pending") + senders +
      this.segments(key).reduce((total, segment) => total + 32 + (segment.opening ? bytes(segment.opening) : 0), 0);
  }

  private bound(key: string): void {
    const db = this.database();
    let segments = this.segments(key);
    let rows = db.prepare("SELECT idx,bytes,user_prompt FROM messages WHERE chat_key=? ORDER BY idx").all(key) as Array<{ idx: number; bytes: number; user_prompt: number }>;
    while (rows.length && (rows.length > this.limits.chatRows || this.measure(key) > this.limits.chatBytes)) {
      let count = rows.length, total = this.measure(key), cut = 0;
      while (cut < rows.length && (count > this.limits.chatRows || total > this.limits.chatBytes)) {
        total -= rows[cut].bytes; count--; cut++;
      }
      const first = rows[cut];
      const containing = first && segments.find(segment => segment.start_index <= first.idx && segment.end_index > first.idx);
      const opening = first && !first.user_prompt && containing ? this.opening(key, first.idx, containing) : null;
      db.prepare("DELETE FROM messages WHERE chat_key=? AND idx<=?").run(key, rows[cut - 1].idx);
      if (first) segments = [{ start_index: first.idx, end_index: first.idx + 1, opening }, ...segments];
      this.rebuildSegments(key, segments); segments = this.segments(key); rows = rows.slice(cut);
    }
    if (this.measure(key) > this.limits.chatBytes) throw new Capacity();
    db.prepare("UPDATE chats SET bytes=? WHERE key=?").run(this.measure(key), key);
    const protectedKeys = new Set(this.openChats.values());
    const ordered = db.prepare("SELECT key,bytes FROM chats ORDER BY last_read,key").all() as Array<{ key: string; bytes: number }>;
    let total = ordered.reduce((sum, chat) => sum + chat.bytes, 0);
    for (const chat of ordered) {
      if (total <= this.limits.channelBytes) break;
      if (protectedKeys.has(chat.key)) continue;
      db.prepare("DELETE FROM chats WHERE key=?").run(chat.key); total -= chat.bytes;
    }
    if (total > this.limits.channelBytes) throw new Capacity();
  }

  putRange(input: CloudCacheKey, raw: CloudCacheRange): boolean {
    const key = cloudCacheKey(input), page = CloudCacheRangeSchema.parse(raw);
    const previous = this.chat(key);
    if (previous && previous.revision > page.revision) return false;
    return this.transaction(() => {
      const current = this.chat(key);
      if (current && current.revision > page.revision) throw new Capacity();
      if (current && current.revision !== page.revision) this.database().prepare("DELETE FROM chats WHERE key=?").run(key);
      else if (current && current.message_count !== page.messageCount) throw unavailable();
      const db = this.database();
      if (current?.revision === page.revision) {
        const lookup = db.prepare("SELECT * FROM messages WHERE chat_key=? AND idx=?");
        for (const row of page.rows) {
          const previous = lookup.get(key, row.index) as Message | undefined;
          if (previous && (previous.msg_id !== row.msgId || previous.kind !== row.kind || previous.payload !== row.payload || previous.created_at !== row.createdAt)) throw unavailable();
        }
        if (encoded(page.historyState) !== current.history_state) throw unavailable();
      }
      db.prepare(`INSERT INTO chats (key,owner,organization,workspace,chat,revision,message_count,history_state,last_read) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET history_state=excluded.history_state`).run(key, input.owner, input.organizationId, input.workspaceId, input.chatId,
        page.revision, page.messageCount, encoded(page.historyState), current?.last_read ?? this.now());
      const segments = this.segments(key);
      this.upsertRows(key, page.rows);
      this.putSenders(key, [...page.rows, ...(page.turnOpening ? [page.turnOpening] : [])], page.senders);
      this.rebuildSegments(key, [{ start_index: page.fromIndex, end_index: page.toIndex, opening: encoded(page.turnOpening) }, ...segments]);
      this.bound(key);
    }, key) && this.chat(key) !== undefined;
  }

  applyDelta(input: CloudCacheKey, raw: CloudCacheDelta, expectedRevision?: number): boolean {
    const key = cloudCacheKey(input), delta = CloudCacheDeltaSchema.parse(raw);
    if (delta.resync) {
      if (expectedRevision === undefined || this.chat(key)?.revision !== expectedRevision) return false;
      return this.transaction(() => {
        if (this.chat(key)?.revision !== expectedRevision) throw new Capacity();
        this.database().prepare("DELETE FROM chats WHERE key=?").run(key);
      });
    }
    if (this.chat(key)?.revision !== delta.fromRevision) return false;
    return this.transaction(() => {
      const current = this.chat(key);
      if (!current || current.revision !== delta.fromRevision) throw new Capacity();
      if (delta.messageCount < current.message_count || delta.revision === current.revision && delta.messageCount !== current.message_count) throw unavailable();
      if (delta.revision === current.revision && encoded(delta.historyState) !== current.history_state) throw unavailable();
      const appended = new Set(delta.rows.filter(row => row.index >= current.message_count).map(row => row.index));
      if (appended.size !== delta.messageCount - current.message_count) throw unavailable();
      const segments = this.segments(key);
      for (const segment of segments) if (segment.opening) {
        const opening = CloudCacheMessageSchema.parse(JSON.parse(segment.opening));
        const changed = delta.rows.find(row => row.msgId === opening.msgId);
        if (changed) segment.opening = JSON.stringify(changed);
      }
      const tail = current.message_count === 0 || segments.at(-1)?.end_index === current.message_count;
      this.upsertRows(key, delta.rows.filter(row => row.index >= current.message_count ? tail :
        segments.some(segment => segment.start_index <= row.index && row.index < segment.end_index)));
      this.putSenders(key, delta.rows, delta.senders);
      this.database().prepare("UPDATE chats SET revision=?,message_count=?,history_state=? WHERE key=?")
        .run(delta.revision, delta.messageCount, encoded(delta.historyState), key);
      this.rebuildSegments(key, segments);
      this.bound(key);
    }, key);
  }

  readTail(input: CloudCacheKey, limit = 200): CloudCacheRange | null {
    const key = cloudCacheKey(input), chat = this.chat(key);
    if (!chat || !Number.isInteger(limit) || limit < 1 || limit > 500) return null;
    const segment = this.segments(key).at(-1);
    if (!segment) return chat.message_count === 0 ? this.readRange(input, 0, 0) : null;
    return this.readRange(input, Math.max(segment.start_index, segment.end_index - limit), segment.end_index);
  }

  readBefore(input: CloudCacheKey, revision: number, before: string, limit: number): CloudCacheRange | null {
    const key = cloudCacheKey(input), chat = this.chat(key);
    if (!chat || chat.revision !== revision || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) return null;
    const cursor = this.database().prepare("SELECT idx FROM messages WHERE chat_key=? AND msg_id=?").get(key, before) as { idx: number } | undefined;
    if (!cursor) return null;
    if (cursor.idx === 0) return this.readRange(input, 0, 0);
    const segment = this.segments(key).find(segment => segment.start_index < cursor.idx && segment.end_index >= cursor.idx);
    return segment ? this.readRange(input, Math.max(segment.start_index, cursor.idx - limit), cursor.idx) : null;
  }

  readRange(input: CloudCacheKey, fromIndex: number, toIndex: number): CloudCacheRange | null {
    const key = cloudCacheKey(input), chat = this.chat(key);
    if (!chat || !Number.isSafeInteger(fromIndex) || !Number.isSafeInteger(toIndex) || fromIndex < 0 ||
      toIndex < fromIndex || toIndex > chat.message_count || toIndex - fromIndex > 500) return null;
    const segment = this.segments(key).find(segment => segment.start_index <= fromIndex && segment.end_index >= toIndex);
    if (fromIndex !== toIndex && !segment) return null;
    const stored = this.database().prepare("SELECT * FROM messages WHERE chat_key=? AND idx>=? AND idx<? ORDER BY idx").all(key, fromIndex, toIndex) as Message[];
    const rows = stored.map(native);
    const opening = segment && !stored[0]?.user_prompt ? this.opening(key, fromIndex, segment) : null;
    let openingId: unknown;
    try { openingId = opening ? (JSON.parse(opening) as { msgId?: unknown }).msgId : undefined; } catch { openingId = undefined; }
    const ids = [...stored.map(row => row.msg_id), ...(typeof openingId === "string" ? [openingId] : [])];
    const lookup = this.database().prepare("SELECT sender FROM senders WHERE chat_key=? AND msg_id=?");
    const known = ids.flatMap(id => { const hit = lookup.get(key, id) as { sender: string } | undefined; return hit ? [[id, JSON.parse(hit.sender) as unknown] as const] : []; });
    const senders = known.length ? Object.fromEntries(known) : undefined;
    let result;
    try {
      result = CloudCacheRangeSchema.safeParse({ revision: chat.revision, messageCount: chat.message_count, fromIndex, toIndex, rows,
        ...(chat.history_state ? { historyState: JSON.parse(chat.history_state) } : {}), ...(opening ? { turnOpening: JSON.parse(opening) } : {}),
        ...(senders ? { senders } : {}) });
    } catch { this.forget(input); return null; }
    if (!result.success) { this.forget(input); return null; }
    // Recency is kept in memory and written with the next mutation: a read never contends for the writer lock.
    this.recency.delete(key); this.recency.set(key, this.now());
    while (this.recency.size > 4096) this.recency.delete(this.recency.keys().next().value!);
    return result.data;
  }

  putPending(input: CloudCacheKey, raw: CloudCachePending): boolean {
    const key = cloudCacheKey(input), page = CloudCachePendingSchema.parse(raw), chat = this.chat(key);
    if (page.items.some(item => item.receipt.workspaceId !== input.workspaceId || item.receipt.chatId !== input.chatId ||
      item.payload && (item.payload.chatId !== input.chatId || item.payload.userMessageId !== item.receipt.userMessageId))) throw unavailable();
    if (!chat || chat.queue_revision !== null && chat.queue_revision > page.queueRevision) return false;
    return this.transaction(() => {
      const current = this.chat(key);
      if (!current || current.queue_revision !== null && current.queue_revision > page.queueRevision) throw new Capacity();
      if (current.queue_revision === page.queueRevision) {
        const previous = this.readPending(input)!;
        if (JSON.stringify(previous) !== JSON.stringify(page)) throw unavailable();
        return;
      }
      this.database().prepare("DELETE FROM pending WHERE chat_key=?").run(key);
      const insert = this.database().prepare("INSERT INTO pending VALUES (?,?,?,?,?,?,?)");
      for (const item of page.items) {
        const value = JSON.stringify(item), hash = createHash("sha256").update(JSON.stringify(item.payload)).digest("hex");
        insert.run(key, item.receipt.userMessageId, item.receipt.epoch, item.state, hash, value, bytes(value) + 64);
      }
      this.database().prepare("UPDATE chats SET queue_revision=?,queue_epoch=? WHERE key=?").run(page.queueRevision, page.epoch, key);
      if (this.measure(key) > this.limits.chatBytes) throw new Capacity();
      this.bound(key);
    }, key);
  }

  readPending(input: CloudCacheKey): CloudCachePending | null {
    const key = cloudCacheKey(input), chat = this.chat(key);
    if (!chat || chat.queue_revision === null || chat.queue_epoch === null) return null;
    try {
      const stored = this.database().prepare("SELECT status FROM pending WHERE chat_key=?").all(key) as Array<{ status: string }>;
      const items = stored.map(row => JSON.parse(row.status) as CloudCachePending["items"][number]);
      items.sort((left, right) => BigInt(left.receipt.sequence) < BigInt(right.receipt.sequence) ? -1 : 1);
      const pending = CloudCachePendingSchema.parse({ queueRevision: chat.queue_revision, epoch: chat.queue_epoch, items });
      if (pending.items.some(item => item.receipt.workspaceId !== input.workspaceId || item.receipt.chatId !== input.chatId ||
        item.payload && (item.payload.chatId !== input.chatId || item.payload.userMessageId !== item.receipt.userMessageId))) throw unavailable();
      return pending;
    } catch { this.forget(input); return null; }
  }

  list(owner: string, after: string | null, limit = 500): { items: CloudCacheTarget[]; nextAfter: string | null } {
    if (!owner || owner.length > 2048 || after !== null && (typeof after !== "string" || after.length > 16_384) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw unavailable();
    const rows = this.database().prepare("SELECT key,organization,workspace,chat FROM chats WHERE owner=? AND key>? ORDER BY key LIMIT ?")
      .all(owner, after ?? "", limit + 1) as Array<{ key: string; organization: string; workspace: string; chat: string }>;
    return { items: rows.slice(0, limit).map(row => CloudCacheTargetSchema.parse({ organizationId: row.organization, workspaceId: row.workspace, chatId: row.chat })),
      nextAfter: rows.length > limit ? rows[limit - 1].key : null };
  }

  bytes(): number { return (this.database().prepare("SELECT coalesce(sum(bytes),0) AS bytes FROM chats").get() as { bytes: number }).bytes; }
  forget(input: CloudCacheKey): void { this.transaction(() => { this.database().prepare("DELETE FROM chats WHERE key=?").run(cloudCacheKey(input)); }); }
  forgetWorkspace(owner: string, organization: string, workspace: string): void {
    this.transaction(() => { this.database().prepare("DELETE FROM chats WHERE owner=? AND organization=? AND workspace=?").run(owner, organization, workspace); });
  }
  retireOwner(owner: string, session?: string): void {
    this.transaction(() => {
      const current = this.database().prepare("SELECT session FROM accounts WHERE owner=?").get(owner) as { session: string } | undefined;
      if (session !== undefined && current?.session !== sessionDigest(session)) return;
      this.database().prepare("DELETE FROM chats WHERE owner=?").run(owner);
      this.database().prepare("DELETE FROM accounts WHERE owner=?").run(owner);
    });
  }
}
