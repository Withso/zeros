import { CLOUD_V2_MAX_FRAME_BYTES, CLOUD_V2_MAX_HISTORY_ROWS, type CloudV2HistoryState, type CloudV2MessageRow, type CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
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
    private readonly sanitize: <T>(value: T) => T = value => value) {
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
    for (const chatId of chatDeletions) this.pending.set(chatId, { deleted: true, revision: 0, rows: new Map(), due: 0 });
    for (const chat of chats) this.pending.set(chat.id, { chat, ...(this.replacement() ? { replace: true, historyState: this.store.historyState(chat.id) } : {}),
      revision: this.store.historyRevision(chat.id), rows: new Map(this.store.history(chat.id).map((row) => [row.msgId, row])), due: 0 });
    this.drain();
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
    this.sending = Promise.resolve().then(async () => {
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
          for (const source of pending.rows.values()) {
            const row = this.sanitize(source);
            const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
            if (rows.length && (rows.length === CLOUD_V2_MAX_HISTORY_ROWS || size + bytes > CLOUD_V2_MAX_FRAME_BYTES)) {
              batch(); rows = []; size = 1024;
            }
            rows.push(row); size += bytes;
          }
          if (rows.length || replace) batch();
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
      .finally(() => { this.sending = undefined; if (this.online && this.pending.size) this.drain(); });
  }
}
