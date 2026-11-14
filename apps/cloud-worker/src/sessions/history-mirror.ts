import { createHash } from "node:crypto";
import { CLOUD_V2_MAX_FRAME_BYTES, CLOUD_V2_MAX_HISTORY_ROWS, CloudV2HistoryDigestsReplySchema, type CloudV2HistoryState, type CloudV2MessageRow, type CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import type { Transport } from "../transport";
import type { ChatRow } from "./chat-history";
import type { SessionChange, SessionStore } from "./session-store";

interface Pending { chat?: ChatRow; deleted?: true; replace?: true; revision: number; historyState?: CloudV2HistoryState; rows: Map<string, CloudV2MessageRow>; due: number;
  /** chat-edit-v1: acknowledged only in the frame that carries this chat's row. */
  ack?: string }

/** Live viewers use bridge frames. The sleeping-VM mirror batches streamed
 * rows on a one-second trailing edge; durable changes and turn end flush it.
 * Reconnect takes a current snapshot instead of buffering offline streams. */
export class HistoryMirror {
  private online = false;
  private epoch = 0;
  private pending = new Map<string, Pending>();
  private sending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe: () => void;

  constructor(private readonly store: SessionStore, private readonly transport: Transport, private readonly replacement = () => false,
    private readonly sanitize: <T>(value: T) => T = value => value,
    /** history-digest-v1: enabled when the control plane serves digests; `restored` (a boot from a checkpoint, possibly
     * older than the control plane's rows) replaces every remaining live chat. */
    private readonly digests?: { enabled(): boolean; restored(): boolean }) {
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
    // A boot restored from a checkpoint (possibly older than the control plane's rows) replaces everything once.
    const restored = this.firstConnect && !!this.digests?.restored(); this.firstConnect = false;
    if (this.negotiated() && this.transport.historyDigests) {
      // One read of the stored digests; only chats whose content differs are replaced (a restored boot replaces all, but
      // the read still proves the route). flush() and runtimeBusy wait for it.
      const epoch = this.epoch;
      const sending = this.reconcile(epoch, restored, chatDeletions).finally(() => {
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

  private firstConnect = true;
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
    if (deleted) for (const chat of this.store.list().chats) {
      if (!deleted.has(chat.id)) continue;
      await this.store.delete(chat.id);
      await this.store.forgetTombstone(chat.id);
      if (epoch !== this.epoch || !this.online) return;
      this.pending.delete(chat.id);
    }
    // Only deletion-list support proves the server retains tombstones after local pruning.
    for (const chatId of tombstones) {
      if (!stored || restored || stored.has(chatId)) { this.pending.set(chatId, { deleted: true, revision: 0, rows: new Map(), due: 0 }); continue; }
      if (deleted) { await this.store.forgetTombstone(chatId); if (epoch !== this.epoch || !this.online) return; }
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

  get runtimeBusy(): boolean { return !this.online || this.pending.size > 0 || !!this.sending; }
  disconnect(): void { this.online = false; this.epoch++; this.pending.clear(); clearTimeout(this.timer); this.timer = undefined; }
  async flush(): Promise<boolean> {
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
    const pending: Pending = this.pending.get(change.chatId) ?? { rows: new Map(), revision: this.store.historyRevision(change.chatId), due: Date.now() + 1000 };
    if (change.flush || change.chat || change.deleted) pending.due = 0;
    if (change.deleted) { pending.deleted = true; pending.chat = undefined; pending.rows.clear(); }
    else {
      if (change.replace) { pending.replace = true; pending.rows.clear(); pending.revision = this.store.historyRevision(change.chatId); pending.historyState = this.store.historyState(change.chatId); }
      if (change.chat) pending.chat = change.chat;
      for (const row of change.rows) pending.rows.set(row.msgId, row);
    }
    this.pending.set(change.chatId, pending);
    this.drain();
  }

  private drain(): void {
    if (this.sending || !this.online) return;
    clearTimeout(this.timer); this.timer = undefined;
    const ready = () => [...this.pending].find(([, pending]) => pending.due <= Date.now());
    if (!ready()) {
      if (this.pending.size) {
        const delay = Math.max(0, Math.min(...[...this.pending.values()].map(pending => pending.due)) - Date.now());
        this.timer = setTimeout(() => { this.timer = undefined; this.drain(); }, delay);
        this.timer.unref?.();
      }
      return;
    }
    const epoch = this.epoch;
    const sending = Promise.resolve().then(async () => {
      while (this.online && epoch === this.epoch && this.pending.size) {
        const entry = ready();
        if (!entry) break;
        const [chatId, pending] = entry;
        this.pending.delete(chatId);
        const frames: CloudV2WorkerFrame[] = [];
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
}
