import { onActiveBridgeConnected } from "../../platform/bridge/active-bridge";
import { cloudWorkspaceKey, parseCloudScopedId } from "../../platform/bridge/cloud-workspace-key";
import { canBackgroundSyncCloudWorkspace } from "../../state/cloud-workspace-catalog";

interface PendingRead {
  stop: () => void;
  connection: number;
  attemptedConnection: number;
  pending: boolean;
  running: boolean;
}

/** Failed history reads follow their own workspace connection. Retain each
 * subscription until success/eviction, so a persistent failure cannot schedule
 * an unbounded sequence of retries against an already connected peer. */
export class TranscriptHydrationRetries {
  private readonly reads = new Map<string, PendingRead>();

  constructor(private readonly retry: (chatId: string, isCurrent: () => boolean) => Promise<void>) {}

  add(chatId: string): void {
    let read = this.reads.get(chatId);
    if (!read) {
      const target = parseCloudScopedId(chatId);
      read = { stop: () => {}, connection: 0, attemptedConnection: 0, pending: true, running: false };
      this.reads.set(chatId, read);
      const owned = read;
      read.stop = onActiveBridgeConnected(() => {
        owned.connection++;
        this.schedule(chatId, owned);
      }, target ? cloudWorkspaceKey(target) : undefined);
    }
    read.pending = true;
    this.schedule(chatId, read);
  }

  delete(chatId: string): void {
    this.reads.get(chatId)?.stop();
    this.reads.delete(chatId);
  }

  /** Cloud-owned history can become readable without a worker reconnect. A
   * confirmed data nudge provides one retry edge; it never revives evicted chats. */
  nudge(chatId: string): void {
    const read = this.reads.get(chatId);
    if (!read) return;
    read.connection++;
    this.schedule(chatId, read);
  }

  clear(): void {
    for (const chatId of this.reads.keys()) this.delete(chatId);
  }

  private schedule(chatId: string, read: PendingRead): void {
    const target = parseCloudScopedId(chatId);
    const available = () => !target || canBackgroundSyncCloudWorkspace(target);
    if (!available()) return;
    if (read.running || !read.pending || read.connection <= read.attemptedConnection) return;
    read.running = true;
    // Defer subscribe-time callbacks until the failed hydrate can settle.
    void Promise.resolve().then(async () => {
      if (this.reads.get(chatId) !== read || !available()) { read.running = false; return; }
      read.attemptedConnection = read.connection;
      read.pending = false;
      try { await this.retry(chatId, () => this.reads.get(chatId) === read && available()); }
      catch { read.pending = true; }
      finally {
        read.running = false;
        if (this.reads.get(chatId) === read) this.schedule(chatId, read);
      }
    });
  }
}
