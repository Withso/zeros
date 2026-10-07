import { z } from "zod";
import { CloudTranscriptOwnerSchema, CloudTranscriptPruneSchema, CachedTranscriptWindowSchema, prepareCachedTranscriptWindow,
  transcriptCacheKey, type CachedTranscriptWindow, type CloudTranscriptOwner, type CloudTranscriptPrune,
} from "../platform/cloud-transcript-cache-contract";

const replySchema = z.object({ cacheEpoch: z.string().uuid(), window: CachedTranscriptWindowSchema.nullable() }).strict();
type Reply = z.infer<typeof replySchema>;
type Token = { owner: CloudTranscriptOwner; generation: number; cacheEpoch?: string };
type Dependencies = {
  isAllowed: (owner: CloudTranscriptOwner) => boolean;
  read: (owner: CloudTranscriptOwner) => Promise<Reply>;
  write: (owner: CloudTranscriptOwner, window: CachedTranscriptWindow, cacheEpoch: string) => Promise<unknown>;
  prune: (scope: CloudTranscriptPrune) => Promise<unknown>;
  maxEntries?: number;
};

/** This cache never owns a transport, wake, retry, or transcript authority.
 * Its windows can provisionally paint; callers still await the server read. */
export class CloudTranscriptCache {
  private account: string | null = null;
  private generation = 0;
  private readonly tokens = new Map<string, Token>();
  private readonly windows = new Map<string, { window: CachedTranscriptWindow; bytes: number }>();
  private readonly flights = new Map<string, Promise<Reply | null>>();
  private readonly maxEntries: number;
  constructor(private readonly dependencies: Dependencies) { this.maxEntries = dependencies.maxEntries ?? 64; }
  setAccount(account: string | null): void {
    this.generation++;
    this.account = account;
    this.tokens.clear(); this.windows.clear(); this.flights.clear();
  }
  private current(token: Token): boolean {
    return this.account === token.owner.accountId && token.generation === this.generation &&
      this.tokens.get(transcriptCacheKey(token.owner)) === token && this.dependencies.isAllowed(token.owner);
  }
  private capture(input: CloudTranscriptOwner): Token | null {
    const parsed = CloudTranscriptOwnerSchema.safeParse(input);
    if (!parsed.success || parsed.data.accountId !== this.account || !this.dependencies.isAllowed(parsed.data)) return null;
    const owner = parsed.data, key = transcriptCacheKey(owner);
    let token = this.tokens.get(key);
    if (!token) {
      token = { owner, generation: this.generation }; this.tokens.set(key, token);
      while (this.tokens.size > this.maxEntries * 2) this.forget(this.tokens.keys().next().value!);
    }
    return token;
  }
  private forget(key: string): void { this.tokens.delete(key); this.windows.delete(key); this.flights.delete(key); }
  peek(owner: CloudTranscriptOwner): CachedTranscriptWindow | null {
    const parsed = CloudTranscriptOwnerSchema.safeParse(owner);
    if (!parsed.success) return null;
    const key = transcriptCacheKey(parsed.data), token = this.tokens.get(key), entry = this.windows.get(key);
    if (!token || !this.current(token) || !entry) return null;
    this.windows.delete(key); this.windows.set(key, entry);
    return entry.window;
  }
  private remember(token: Token, window: CachedTranscriptWindow): CachedTranscriptWindow {
    const key = transcriptCacheKey(token.owner), previous = this.windows.get(key);
    if (previous && previous.window.recordEpoch === window.recordEpoch && previous.window.revision >= window.revision) return previous.window;
    this.windows.delete(key); this.windows.set(key, { window, bytes: new TextEncoder().encode(JSON.stringify(window)).byteLength });
    let bytes = [...this.windows.values()].reduce((total, entry) => total + entry.bytes, 0);
    while (this.windows.size > this.maxEntries || bytes > 24 * 1024 * 1024) {
      const oldest = this.windows.keys().next().value!;
      bytes -= this.windows.get(oldest)!.bytes; this.forget(oldest);
    }
    return window;
  }
  private receipt(token: Token): Promise<Reply | null> {
    const key = transcriptCacheKey(token.owner), previous = this.flights.get(key);
    if (previous) return previous;
    const request = (async () => {
      try {
        const parsed = replySchema.parse(await this.dependencies.read(token.owner));
        if (!this.current(token)) return null;
        token.cacheEpoch = parsed.cacheEpoch;
        if (parsed.window) this.remember(token, prepareCachedTranscriptWindow(parsed.window));
        return parsed;
      } catch { return null; }
    })().finally(() => { if (this.flights.get(key) === request) this.flights.delete(key); });
    this.flights.set(key, request);
    return request;
  }
  async read(owner: CloudTranscriptOwner): Promise<CachedTranscriptWindow | null> {
    const token = this.capture(owner);
    if (!token) return null;
    const remembered = this.peek(owner);
    if (remembered) return remembered;
    await this.receipt(token);
    return this.current(token) ? this.peek(owner) : null;
  }
  async confirm(owner: CloudTranscriptOwner, input: CachedTranscriptWindow): Promise<void> {
    await this.captureConfirmation(owner)?.(input);
  }
  /** Capture before a server read. A retired token cannot allocate a fresh
   * owner when that read later completes, including after a chat tombstone. */
  captureConfirmation(owner: CloudTranscriptOwner): ((input: CachedTranscriptWindow) => Promise<void>) | null {
    const token = this.capture(owner);
    return token ? input => this.confirmCaptured(token, input) : null;
  }
  private async confirmCaptured(token: Token, input: CachedTranscriptWindow): Promise<void> {
    if (!this.current(token)) return;
    const window = prepareCachedTranscriptWindow(input), previous = this.peek(token.owner);
    if (previous && previous.recordEpoch === window.recordEpoch && previous.revision > window.revision) return;
    const remembered = this.remember(token, window);
    if (!token.cacheEpoch) await this.receipt(token);
    if (!this.current(token) || !token.cacheEpoch || this.peek(token.owner) !== remembered) return;
    try { await this.dependencies.write(token.owner, remembered, token.cacheEpoch); } catch { /* Durable caching is optional. */ }
  }
  async prune(input: CloudTranscriptPrune): Promise<void> {
    const scope = CloudTranscriptPruneSchema.parse(input);
    if (scope.accountId !== this.account) return;
    const retained = scope.retainedWorkspaces && new Set(scope.retainedWorkspaces.map(target => JSON.stringify([target.organizationId, target.workspaceId])));
    for (const [key, token] of this.tokens) {
      const owner = token.owner;
      if (retained && retained.has(JSON.stringify([owner.organizationId, owner.workspaceId]))) continue;
      if (owner.accountId !== scope.accountId || scope.organizationId && owner.organizationId !== scope.organizationId ||
          scope.workspaceId && owner.workspaceId !== scope.workspaceId || scope.chatId && owner.chatId !== scope.chatId) continue;
      this.forget(key);
    }
    try { await this.dependencies.prune(scope); } catch { /* Main independently prunes retired accounts. */ }
  }
}
