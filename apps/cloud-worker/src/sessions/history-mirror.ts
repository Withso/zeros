import { CLOUD_V2_MAX_FRAME_BYTES, CLOUD_V2_MAX_HISTORY_ROWS, type CloudV2MessageRow, type CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import type { Transport } from "../transport";
import type { ChatRow } from "./chat-history";
import type { SessionChange, SessionStore } from "./session-store";

interface Pending { chat?: ChatRow; deleted?: true; rows: Map<string, CloudV2MessageRow> }

/** Coalesce changed rows while a send is pending. Offline history remains on
 * disk; reconnect takes a current snapshot instead of buffering event streams. */
export class HistoryMirror {
  private online = false;
  private epoch = 0;
  private pending = new Map<string, Pending>();
  private sending?: Promise<void>;
  private unsubscribe: () => void;

  constructor(private readonly store: SessionStore, private readonly transport: Transport) {
    this.unsubscribe = store.onChange((change) => this.change(change));
  }

  connect(): void {
    this.online = true;
    this.epoch++;
    this.pending.clear();
    const { chats, chatDeletions } = this.store.list();
    for (const chatId of chatDeletions) this.pending.set(chatId, { deleted: true, rows: new Map() });
    for (const chat of chats) this.pending.set(chat.id, { chat, rows: new Map(this.store.history(chat.id).map((row) => [row.msgId, row])) });
    this.drain();
  }

  disconnect(): void { this.online = false; this.epoch++; this.pending.clear(); }
  async flush(): Promise<void> { while (this.sending) await this.sending; }
  async dispose(): Promise<void> { this.unsubscribe(); this.disconnect(); await this.flush(); }

  private change(change: SessionChange): void {
    if (!this.online) return;
    const pending: Pending = this.pending.get(change.chatId) ?? { rows: new Map() };
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
    this.sending = Promise.resolve().then(async () => {
      const epoch = this.epoch;
      while (this.online && epoch === this.epoch && this.pending.size) {
        const [chatId, pending] = this.pending.entries().next().value!;
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
    }).finally(() => { this.sending = undefined; if (this.online && this.pending.size) this.drain(); });
  }
}
