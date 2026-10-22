import { CLOUD_V2_MAX_FRAME_BYTES, CLOUD_V2_MAX_HISTORY_ROWS, type CloudV2MessageRow, type CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import type { Transport } from "../transport";
import type { ChatRow } from "./chat-history";
import type { SessionChange, SessionStore } from "./session-store";

interface Pending { chat?: ChatRow; deleted?: true; rows: Map<string, CloudV2MessageRow>; due: number }

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

  constructor(private readonly store: SessionStore, private readonly transport: Transport) {
    this.unsubscribe = store.onChange((change) => this.change(change));
  }

  connect(): void {
    this.online = true;
    this.epoch++;
    this.pending.clear();
    const { chats, chatDeletions } = this.store.list();
    for (const chatId of chatDeletions) this.pending.set(chatId, { deleted: true, rows: new Map(), due: 0 });
    for (const chat of chats) this.pending.set(chat.id, { chat, rows: new Map(this.store.history(chat.id).map((row) => [row.msgId, row])), due: 0 });
    this.drain();
  }

  disconnect(): void { this.online = false; this.epoch++; this.pending.clear(); clearTimeout(this.timer); this.timer = undefined; }
  async flush(): Promise<void> {
    do {
      for (const pending of this.pending.values()) pending.due = 0;
      this.drain();
      await this.sending;
    } while (this.sending || (this.online && this.pending.size));
  }
  async dispose(): Promise<void> { this.unsubscribe(); await this.flush(); this.disconnect(); }

  private change(change: SessionChange): void {
    if (!this.online) return;
    const pending: Pending = this.pending.get(change.chatId) ?? { rows: new Map(), due: Date.now() + 1000 };
    if (change.flush || change.chat || change.deleted) pending.due = 0;
    if (change.deleted) { pending.deleted = true; pending.chat = undefined; pending.rows.clear(); }
    else {
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
          if (pending.chat) frames.push({ t: "history", chats: [{ ...pending.chat }] });
          let rows: CloudV2MessageRow[] = [], size = 1024;
          for (const row of pending.rows.values()) {
            const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
            if (rows.length && (rows.length === CLOUD_V2_MAX_HISTORY_ROWS || size + bytes > CLOUD_V2_MAX_FRAME_BYTES)) {
              frames.push({ t: "history", messages: { chatId, rows } }); rows = []; size = 1024;
            }
            rows.push(row); size += bytes;
          }
          if (rows.length) frames.push({ t: "history", messages: { chatId, rows } });
        }
        for (const frame of frames) {
          if (!this.online || epoch !== this.epoch) break;
          if (!await this.transport.send(frame)) { if (epoch === this.epoch) this.disconnect(); break; }
        }
      }
    }).catch(() => { if (epoch === this.epoch) this.disconnect(); })
      .finally(() => { this.sending = undefined; if (this.online && this.pending.size) this.drain(); });
  }
}
