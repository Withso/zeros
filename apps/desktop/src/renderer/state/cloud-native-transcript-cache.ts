import { cloudScopedId, cloudWorkspaceKey, parseCloudScopedId } from "../platform/bridge/cloud-workspace-key";
import type { CloudCacheKnown, CloudCacheTarget } from "../../../shared/cloud-chat-cache";
import { acceptHistorySenders } from "../platform/chat-senders";
import type { NativeCloudChatCacheClient, NativeCloudCacheSnapshot } from "../platform/cloud-chat-cache-client";
import type { LocalTranscriptCache, LocalTranscriptWindow } from "./local-transcript-cache";

function target(chatId: string): CloudCacheTarget | null {
  try {
    const scope = parseCloudScopedId(chatId);
    return scope && { organizationId: scope.organizationId, workspaceId: scope.workspaceId, chatId: scope.id };
  } catch { return null; }
}

export function createNativeCloudTranscriptCache(
  Base: typeof LocalTranscriptCache,
  native: NativeCloudChatCacheClient,
  decode: (snapshot: NativeCloudCacheSnapshot, owner: string, epoch: number) => LocalTranscriptWindow | null,
  /** The chat's revision from the confirmed chats.list snapshot: an unchanged chat revalidates with no read. */
  known: (chatId: string) => Promise<CloudCacheKnown | undefined> = async () => undefined,
): LocalTranscriptCache {
  return new class extends Base {
    private nativeEpoch = -1;
    private readonly nativeReads = new Map<string, Promise<LocalTranscriptWindow | null>>();
    private readonly warming = new Map<string, Promise<unknown>>();
    private readonly refreshAgain = new Set<string>();

    constructor() { super({ namespace: "cloud", store: null, memoryEntries: 8, memoryBytes: 8 * 1024 * 1024 }); }
    override bindOwner(owner: string | null, retire: boolean): void {
      if (native.owner !== owner) native.bindOwner(owner);
      const changed = this.nativeEpoch !== native.epoch;
      super.bindOwner(owner, retire || changed);
      if (changed || retire) { this.nativeReads.clear(); this.warming.clear(); this.refreshAgain.clear(); }
      this.nativeEpoch = native.epoch;
    }
    private warm(chatId: string, key: CloudCacheTarget, settled = false): void {
      if (this.warming.has(chatId)) {
        if (settled) this.refreshAgain.add(chatId);
        return;
      }
      const epoch = native.epoch;
      const flight = known(chatId).catch(() => undefined).then(revision => {
        if (epoch !== native.epoch || this.warming.get(chatId) !== flight) return null;
        return native.refresh(key, 200, revision);
      }).then(refreshed => {
        if (!refreshed || refreshed.cached) return;
        if (epoch === native.epoch && this.warming.get(chatId) === flight) return native.refreshPending(key);
      }).catch(() => {}).finally(() => {
        if (this.warming.get(chatId) !== flight) return;
        this.warming.delete(chatId);
        if (this.refreshAgain.delete(chatId) && epoch === native.epoch && this.isOwner(native.owner)) this.warm(chatId, key);
      });
      this.warming.set(chatId, flight);
    }
    override remember(chatId: string, folder: string | null | undefined, window: LocalTranscriptWindow): void {
      const before = this.peek(chatId);
      super.remember(chatId, folder, window);
      const key = target(chatId);
      if (!key || cloudWorkspaceKey(key) !== folder || !this.isOwner(native.owner) || window.source !== "worker" ||
          window.cloudCache || window.messages.length === 0) return;
      if (before?.source === "worker" && before.messages === window.messages && before.leadingPrompt === window.leadingPrompt &&
          before.historyState === window.historyState) return;
      this.warm(chatId, key, true);
    }
    override read(chatId: string): Promise<LocalTranscriptWindow | null> {
      const key = target(chatId), owner = native.owner;
      if (!key || !owner || !this.isOwner(owner)) return Promise.resolve(null);
      const memory = this.peek(chatId);
      if (memory) { this.warm(chatId, key); return Promise.resolve(memory); }
      const previous = this.nativeReads.get(chatId);
      if (previous) return previous;
      const epoch = this.epoch, nativeEpoch = native.epoch;
      const flight: Promise<LocalTranscriptWindow | null> = native.read(key, 200).then(snapshot => {
        if (epoch !== this.epoch || nativeEpoch !== native.epoch || !this.isOwner(owner) || this.nativeReads.get(chatId) !== flight) return null;
        // Team sharing: a painted cached transcript carries its stored senders, so attribution asks nothing.
        if (snapshot?.range?.senders) acceptHistorySenders(key, key.chatId, snapshot.range.senders);
        const live = this.peek(chatId);
        if (live) return live;
        const value = snapshot && decode(snapshot, owner, nativeEpoch);
        if (!value) return null;
        super.remember(chatId, cloudWorkspaceKey(key), value);
        return this.peek(chatId);
      }).catch(() => null).finally(() => {
        if (this.nativeReads.get(chatId) === flight) {
          this.nativeReads.delete(chatId);
          if (epoch === this.epoch && nativeEpoch === native.epoch && this.isOwner(owner)) this.warm(chatId, key);
        }
      });
      this.nativeReads.set(chatId, flight);
      return flight;
    }
    override forget(chatId: string): void {
      super.forget(chatId); this.nativeReads.delete(chatId); this.warming.delete(chatId); this.refreshAgain.delete(chatId);
      const key = target(chatId);
      if (key) void native.forget([key]).catch(() => {});
    }
    override retain(keep: (chatId: string, folder: string) => boolean): void {
      super.retain(keep);
      const owner = native.owner, epoch = native.epoch, memoryEpoch = this.epoch;
      if (!owner || !this.isOwner(owner)) return;
      const current = () => owner === native.owner && epoch === native.epoch && memoryEpoch === this.epoch && this.isOwner(owner);
      void (async () => {
        let after: string | null = null;
        const cursors = new Set<string>();
        do {
          const page = await native.list(after);
          if (!current()) return;
          const removed = page.items.filter(key => !keep(cloudScopedId(key, key.chatId), cloudWorkspaceKey(key)));
          if (removed.length) await native.forget(removed);
          if (!current() || page.nextAfter === null || cursors.has(page.nextAfter)) return;
          cursors.add(page.nextAfter); after = page.nextAfter;
        } while (current());
      })().catch(() => {});
    }
    override resetForTesting(): void { super.resetForTesting(); this.nativeReads.clear(); this.warming.clear(); this.refreshAgain.clear(); }
  }();
}
