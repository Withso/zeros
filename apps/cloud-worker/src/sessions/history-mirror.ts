import { createHash } from "node:crypto";
import { CLOUD_V2_MAX_FRAME_BYTES, CLOUD_V2_MAX_HISTORY_BATCH_FRAMES, CLOUD_V2_MAX_HISTORY_ROWS, CloudV2HistoryDigestsReplySchema, type CloudV2HistoryState, type CloudV2MessageRow, type CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import type { Transport } from "../transport";
import type { ChatRow } from "./chat-history";
import type { SessionChange, SessionStore } from "./session-store";

interface Pending { chat?: ChatRow; deleted?: true; replace?: true; revision: number; historyState?: CloudV2HistoryState; rows: Map<string, CloudV2MessageRow>; due: number;
  /** chat-edit-v1: acknowledged only in the frame that carries this chat's row. */
  ack?: string }

/** R3 durable channel. Live viewers get every token over bridge frames; the control plane gets whole items and state
 * (Conductor's split). The row a turn streams into (the chat's last row) is held: it goes when the next row starts,
 * with an edit that carries rows, at turn end or a flush (Stop), 5 s after its last fold, or as progress at most every
 * 10 s for readers of the server copy (read-only teammates, other devices, API, search). An edit with no rows while the
 * turn runs (outbox accept/report) keeps holding. Sends are single-flight; whole items a stream completes gather for two
 * seconds, the approved ceiling of one ingest write per two seconds per running chat. Reconnect takes a current snapshot
 * instead of buffering offline streams. */
export const HELD_QUIET_MS = 5_000;
export const HELD_PROGRESS_MS = 10_000;
export const SETTLED_GATHER_MS = 2_000;
/** history-batch-v1: like Conductor's ~80% of 1 MiB per notification request; a single larger frame still goes alone. */
export const HISTORY_BATCH_TARGET_BYTES = 800 * 1024;
export class HistoryMirror {
  private online = false;
  private epoch = 0;
  private pending = new Map<string, Pending>();
  private sending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  /** Per chat, the row a turn is streaming into, since when it has been held, and its release timer. */
  private readonly held = new Map<string, { row: CloudV2MessageRow; since: number; last: number; timer?: ReturnType<typeof setTimeout> }>();
  private unsubscribe: () => void;

  constructor(private readonly store: SessionStore, private readonly transport: Transport, private readonly replacement = () => false,
    private readonly sanitize: <T>(value: T) => T = value => value,
    /** history-digest-v1: enabled when the control plane serves digests; `restored` (a boot from a checkpoint, possibly
     * older than the control plane's rows) replaces every remaining live chat. */
    private readonly digests?: { enabled(): boolean; restored(): boolean; delivered?(): void },
    /** history-batch-v1 negotiated: every ready chat's frames go in one request per drain. */
    private readonly batching: () => boolean = () => false) {
    this.unsubscribe = store.onChange((change) => this.change(change));
  }

  connect(): void {
    const { chats, chatDeletions } = this.store.list();
    if (!this.replacement() && chats.some(chat => this.store.historyRevision(chat.id) > 0)) { this.disconnect(); return; }
    // Replica attaches and login pushes do not reconnect the HTTPS mirror.
    // Backfill only after an actual loss of its durable delivery channel.
    if (this.online) return;
    this.online = true;
    this.epoch++;
    this.pending.clear();
    const tombstone = (chatId: string) => this.pending.set(chatId, { deleted: true, revision: 0, rows: new Map(), due: 0 });
    // A lost connection keeps the restored replacement obligation until one connection drains it in full.
    this.restoredOwed ??= !!this.digests?.restored();
    const restored = this.restoredOwed;
    if (this.negotiated() && this.transport.historyDigests) {
      // One read of the stored digests; only chats whose content differs are replaced (a restored boot replaces all, but
      // the read still proves the route). flush() and runtimeBusy wait for it.
      const epoch = this.epoch;
      const sending = this.reconcile(epoch, restored, chatDeletions).catch(() => {
        if (epoch !== this.epoch) return;
        this.disconnect();
      }).finally(() => {
        if (this.sending !== sending) return;
        this.sending = undefined; this.drain();
      });
      this.sending = sending;
      return;
    }
    for (const chatId of chatDeletions) tombstone(chatId);
    for (const chat of chats) this.pending.set(chat.id, this.snapshot(chat));
    this.drain();
  }

  private restoredOwed?: boolean;
  private settleRestored(): void {
    if (!this.restoredOwed || !this.online || this.sending || this.pending.size) return;
    this.restoredOwed = false;
    this.digests?.delivered?.();
  }
  /** The connection epoch whose digests read succeeded with a valid reply (an empty one included). */
  private stampEpoch = -1;
  private negotiated(): boolean { return !!this.digests?.enabled() && this.replacement(); }
  /** Digests go out only after this connection's read proved the control plane serves them: after a failed or invalid
   * read the replacement carries no optional field, so an older control plane's strict schema still accepts it. */
  private stamping(): boolean { return this.negotiated() && this.stampEpoch === this.epoch; }
  private snapshot(chat: ChatRow): Pending {
    return { chat, ...(this.replacement() ? { replace: true, historyState: this.store.historyState(chat.id) } : {}),
      revision: this.store.historyRevision(chat.id), rows: new Map(this.store.history(chat.id).map((row) => [row.msgId, row])), due: 0 };
  }
  /** What the control plane stores for a chat after its final replacement frame: chat row, history state and rows. */
  private digestOf(chat: ChatRow, historyState: CloudV2HistoryState | undefined, rows: Iterable<CloudV2MessageRow>): string {
    const hash = createHash("sha256");
    hash.update(`chat\0${JSON.stringify(this.sanitize(chat))}\n`).update(`state\0${JSON.stringify(historyState ?? null)}\n`);
    for (const source of rows) {
      const row = this.sanitize(source);
      hash.update(`${row.msgId}\0${row.kind}\0${row.createdAt}\0${createHash("sha256").update(row.payload).digest("hex")}\n`);
    }
    return hash.digest("hex");
  }
  private async reconcile(epoch: number, restored: boolean, tombstones: readonly string[]): Promise<void> {
    let stored: Map<string, string | null> | undefined, deleted: Set<string> | undefined;
    // Any doubt (error, 404, an older control plane, an invalid reply) means today's full replacement, unstamped.
    try {
      const reply = CloudV2HistoryDigestsReplySchema.parse(await this.transport.historyDigests!());
      stored = new Map(reply.chats.map(entry => [entry.chatId, entry.digest]));
      if (reply.deleted) deleted = new Set(reply.deleted);
    } catch { stored = undefined; }
    if (epoch !== this.epoch || !this.online) return;
    if (stored) this.stampEpoch = epoch;
    // Explicit deletions survive checkpoint rollback; absence alone never deletes a live local chat.
    const guarded = new Set(tombstones);
    if (deleted) for (const chatId of deleted) {
      if (!guarded.has(chatId)) await this.store.delete(chatId);
      if (epoch !== this.epoch || !this.online) return;
      this.pending.delete(chatId);
    }
    // Keep the durable local guard against delayed upserts; server acknowledgement only suppresses its POST.
    for (const chatId of tombstones) {
      if (deleted?.has(chatId)) continue;
      if (!stored || restored || stored.has(chatId)) { this.pending.set(chatId, { deleted: true, revision: 0, rows: new Map(), due: 0 }); continue; }
    }
    if (restored) stored = undefined;
    for (const chat of this.store.list().chats) {
      const full = this.snapshot(chat), digest = stored?.get(chat.id);
      if (digest && digest === this.digestOf(full.chat!, full.historyState, full.rows.values())) continue;
      // A chat edit acknowledged during the read rides with the replacement (which then carries no digest).
      const ack = this.pending.get(chat.id)?.ack;
      this.pending.set(chat.id, ack === undefined ? full : { ...full, ack });
    }
  }

  /** Call after the edit is in the store. The next frame for this chat sends
   * its current row with the acknowledgement; offline, the control plane
   * offers the edit again and it is acknowledged again. */
  acknowledgeChatEdit(chatId: string, version: string): void {
    const chat = this.store.metadata(chatId)?.chat;
    if (!this.online || !chat) return;
    const pending: Pending = this.pending.get(chatId) ?? { rows: new Map(), revision: this.store.historyRevision(chatId), due: 0 };
    if (pending.deleted) return;
    pending.chat = chat; pending.due = 0;
    if (pending.ack === undefined || BigInt(version) > BigInt(pending.ack)) pending.ack = version;
    this.pending.set(chatId, pending);
    this.drain();
  }

  get runtimeBusy(): boolean { return !this.online || this.pending.size > 0 || this.held.size > 0 || !!this.sending; }
  disconnect(): void {
    this.online = false; this.epoch++; this.pending.clear();
    for (const entry of this.held.values()) clearTimeout(entry.timer);
    this.held.clear();
    clearTimeout(this.timer); this.timer = undefined;
  }
  /** Moves held rows (one chat, or all for a final mirror: Stop, shutdown, runtime handoff) into the next send. */
  private release(chatId?: string, gathered = false): void {
    for (const [id, entry] of [...this.held]) {
      if (chatId !== undefined && id !== chatId) continue;
      clearTimeout(entry.timer); this.held.delete(id);
      const existing = this.pending.get(id);
      const pending: Pending = existing ?? { rows: new Map(), revision: this.store.historyRevision(id), due: 0 };
      // A timer release joins a gather already running rather than cutting it short.
      if (!gathered || !existing) pending.due = 0;
      if (!pending.deleted) { pending.rows.set(entry.row.msgId, entry.row); this.pending.set(id, pending); }
    }
  }
  private hold(chatId: string, row: CloudV2MessageRow): void {
    const now = Date.now(), previous = this.held.get(chatId);
    const entry = { row, since: previous?.row.msgId === row.msgId ? previous.since : now, last: now, timer: previous?.timer };
    clearTimeout(entry.timer);
    const epoch = this.epoch;
    entry.timer = setTimeout(() => {
      if (epoch !== this.epoch || this.held.get(chatId) !== entry) return;
      this.release(chatId, true); this.drain();
    }, Math.max(0, Math.min(entry.last + HELD_QUIET_MS, entry.since + HELD_PROGRESS_MS) - now));
    entry.timer.unref?.();
    this.held.set(chatId, entry);
  }
  async flush(): Promise<boolean> {
    if (this.online) this.release();
    do {
      for (const pending of this.pending.values()) pending.due = 0;
      this.drain();
      await this.sending;
    } while (this.sending || (this.online && this.pending.size));
    return this.online;
  }
  async dispose(): Promise<void> { this.unsubscribe(); await this.flush(); this.disconnect(); }

  private change(change: SessionChange): void {
    if (!this.online) return;
    if (change.replace && !this.replacement()) { this.disconnect(); return; }
    const { chatId } = change;
    let rows = change.rows;
    if (change.deleted || change.replace) { clearTimeout(this.held.get(chatId)?.timer); this.held.delete(chatId); }
    else if (!change.flush && !change.chat) {
      // A token fold: the chat's last row is the one being streamed into and is held; earlier rows are whole.
      const last = this.store.history(chatId).at(-1)?.msgId, tail = this.held.get(chatId);
      const settled: CloudV2MessageRow[] = [];
      if (tail && tail.row.msgId !== last) {
        // A new item started: the held one is whole (its newest version may ride in this fold).
        clearTimeout(tail.timer); this.held.delete(chatId);
        if (!rows.some(row => row.msgId === tail.row.msgId)) settled.push(tail.row);
      }
      for (const row of rows) { if (row.msgId === last) this.hold(chatId, row); else settled.push(row); }
      if (!settled.length) return;
      rows = settled;
    } else {
      // An edit with nothing of its own to send while the turn runs (an outbox accept or report) keeps holding; the
      // turn's end releases the row at once.
      if (!rows.length && !change.chat && !change.deleted && !change.replace && this.store.running(chatId)) return;
      // A durable boundary carrying rows: the held version rides in the same frame; later folds are held again.
      const tail = this.held.get(chatId);
      clearTimeout(tail?.timer); this.held.delete(chatId);
      if (tail && !rows.some(row => row.msgId === tail.row.msgId)) rows = [tail.row, ...rows];
    }
    const boundary = !!(change.flush || change.chat || change.deleted || change.replace);
    const pending: Pending = this.pending.get(chatId) ?? { rows: new Map(), revision: this.store.historyRevision(chatId), due: boundary ? 0 : Date.now() + SETTLED_GATHER_MS };
    if (boundary) pending.due = 0;
    if (change.deleted) { pending.deleted = true; pending.chat = undefined; pending.rows.clear(); }
    else {
      if (change.replace) { pending.replace = true; pending.rows.clear(); pending.revision = this.store.historyRevision(chatId); pending.historyState = this.store.historyState(chatId); }
      if (change.chat) pending.chat = change.chat;
      for (const row of rows) pending.rows.set(row.msgId, row);
    }
    this.pending.set(chatId, pending);
    this.drain();
  }

  private drain(): void {
    if (this.sending || !this.online) return;
    clearTimeout(this.timer); this.timer = undefined;
    const ready = () => [...this.pending].find(([, pending]) => pending.due <= Date.now());
    if (!ready()) {
      if (!this.pending.size) this.settleRestored();
      if (this.pending.size) {
        const delay = Math.max(0, Math.min(...[...this.pending.values()].map(pending => pending.due)) - Date.now());
        this.timer = setTimeout(() => { this.timer = undefined; this.drain(); }, delay);
        this.timer.unref?.();
      }
      return;
    }
    const epoch = this.epoch;
    const sending = Promise.resolve().then(async () => {
      if (this.batching() && this.transport.sendHistoryBatch) { await this.sendBatches(epoch, ready); return; }
      while (this.online && epoch === this.epoch && this.pending.size) {
        const entry = ready();
        if (!entry) break;
        const [chatId, pending] = entry;
        this.pending.delete(chatId);
        const frames = this.framesFor(chatId, pending);
        for (const frame of frames) {
          if (!this.online || epoch !== this.epoch) break;
          // A cut supersedes every unsent chunk of an older backfill. The
          // in-flight chunk precedes its replacement on the ordered carrier.
          if (!pending.deleted && (this.store.historyRevision(chatId) !== pending.revision || !this.store.metadata(chatId)?.chat)) break;
          if (frame.t === "history" && frame.messages?.replace && !this.replacement()) { this.disconnect(); break; }
          if (!await this.transport.send(frame)) { if (epoch === this.epoch) this.disconnect(); break; }
        }
      }
    }).catch(() => { if (epoch === this.epoch) this.disconnect(); })
      .finally(() => {
        if (this.sending !== sending) return;
        this.sending = undefined; this.drain();
      });
    this.sending = sending;
  }

  /** One chat's pending change as ordered history frames (chat row first, then message chunks; digest on the last). */
  private framesFor(chatId: string, pending: Pending): Array<Extract<CloudV2WorkerFrame, { t: "history" }>> {
        const frames: Array<Extract<CloudV2WorkerFrame, { t: "history" }>> = [];
        if (pending.deleted) frames.push({ t: "history", chatDeletions: [chatId] });
        else {
          if (pending.chat) frames.push({ t: "history", chats: [{ ...this.sanitize(pending.chat) }],
            ...(pending.ack !== undefined ? { chatEditAcks: [{ chatId, version: pending.ack }] } : {}) });
          let rows: CloudV2MessageRow[] = [], size = 1024;
          let replace = pending.replace;
          const batch = () => { frames.push({ t: "history", messages: { chatId, rows, ...(replace ? { replace, historyState: pending.historyState } : {}) } }); replace = undefined; };
          // history-digest-v1: a full replacement with no chat-edit ACK pending stamps its digest on its final frame.
          const digest = pending.replace && pending.chat && pending.ack === undefined && this.stamping()
            ? this.digestOf(pending.chat, pending.historyState, pending.rows.values()) : undefined;
          for (const source of pending.rows.values()) {
            const row = this.sanitize(source);
            const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
            if (rows.length && (rows.length === CLOUD_V2_MAX_HISTORY_ROWS || size + bytes > CLOUD_V2_MAX_FRAME_BYTES)) {
              batch(); rows = []; size = 1024;
            }
            rows.push(row); size += bytes;
          }
          if (rows.length || replace) batch();
          const last = frames.at(-1);
          if (digest && last?.t === "history" && last.messages) last.messages = { ...last.messages, digest };
        }
        return frames;
  }

  /** history-batch-v1: drains every ready chat into as few requests as fit (each chat's frames stay contiguous and in order,
   * so a replacement's chat frame and message frames keep consecutive sequences), single-flight like Conductor's. */
  private async sendBatches(epoch: number, ready: () => [string, Pending] | undefined): Promise<void> {
    const size = (frame: CloudV2WorkerFrame) => Buffer.byteLength(JSON.stringify(frame));
    while (this.online && epoch === this.epoch && this.pending.size) {
      const batch: Array<Extract<CloudV2WorkerFrame, { t: "history" }>> = [];
      let bytes = 0;
      for (let entry = ready(); entry; entry = ready()) {
        const [chatId, pending] = entry;
        // A cut supersedes an unsent backfill; the next change for this chat carries current rows.
        if (!pending.deleted && (this.store.historyRevision(chatId) !== pending.revision || !this.store.metadata(chatId)?.chat)) { this.pending.delete(chatId); continue; }
        const frames = this.framesFor(chatId, pending);
        if (frames.some(frame => frame.messages?.replace) && !this.replacement()) { this.disconnect(); return; }
        const total = frames.reduce((sum, frame) => sum + size(frame), 0);
        if (batch.length && (batch.length + frames.length > CLOUD_V2_MAX_HISTORY_BATCH_FRAMES || bytes + total > HISTORY_BATCH_TARGET_BYTES)) break;
        this.pending.delete(chatId);
        if (!batch.length && (frames.length > CLOUD_V2_MAX_HISTORY_BATCH_FRAMES || total > HISTORY_BATCH_TARGET_BYTES)) {
          // One chat larger than a batch: its frames go in order across several requests.
          let chunk: typeof frames = [], chunkBytes = 0;
          for (const frame of frames) {
            const frameBytes = size(frame);
            if (chunk.length && (chunk.length === CLOUD_V2_MAX_HISTORY_BATCH_FRAMES || chunkBytes + frameBytes > HISTORY_BATCH_TARGET_BYTES)) {
              if (!await this.sendBatch(epoch, chunk)) return;
              chunk = []; chunkBytes = 0;
              // A cut while a chunk was in flight supersedes the rest of this backfill, as for single frames.
              if (!pending.deleted && (this.store.historyRevision(chatId) !== pending.revision || !this.store.metadata(chatId)?.chat)) break;
            }
            chunk.push(frame); chunkBytes += frameBytes;
          }
          if (chunk.length && (pending.deleted || this.store.historyRevision(chatId) === pending.revision && this.store.metadata(chatId)?.chat)
            && !await this.sendBatch(epoch, chunk)) return;
          continue;
        }
        batch.push(...frames); bytes += total;
      }
      if (!batch.length) break;
      if (!await this.sendBatch(epoch, batch)) return;
    }
  }
  private async sendBatch(epoch: number, frames: Array<Extract<CloudV2WorkerFrame, { t: "history" }>>): Promise<boolean> {
    if (!this.online || epoch !== this.epoch) return false;
    if (await this.transport.sendHistoryBatch!(frames)) return true;
    if (epoch === this.epoch) this.disconnect();
    return false;
  }
}
