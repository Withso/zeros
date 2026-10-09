import { z } from "zod";
import { CloudTranscriptOwnerSchema, CloudTranscriptPruneSchema, CachedTranscriptWindowSchema, prepareCachedTranscriptWindow,
  transcriptCacheKey, type CachedTranscriptWindow, type CloudTranscriptOwner, type CloudTranscriptPrune,
  CloudHistoryRestoreFenceSchema, cloudHistoryFenceCanAdvance, cloudHistoryFenceHasTranscript, cloudHistoryFencesMatch,
  CloudHistoryRestoreMetadataSchema, cloudHistoryBindingKey,
  type CloudHistoryRestoreFence, type CloudHistoryRestoreMetadata,
} from "../platform/cloud-transcript-cache-contract";

const replySchema = z.object({ cacheEpoch: z.string().uuid(), historyEpoch: z.string().uuid().optional(),
  restoreHead: CloudHistoryRestoreFenceSchema.optional(), window: CachedTranscriptWindowSchema.nullable() }).strict();
type Reply = z.infer<typeof replySchema>;
type Token = { owner: CloudTranscriptOwner; generation: number; cacheEpoch?: string; historyEpoch?: string;
  restoreHead?: CloudHistoryRestoreFence; authoritativeHead?: boolean };
type Dependencies = {
  isAllowed: (owner: CloudTranscriptOwner) => boolean;
  read: (owner: CloudTranscriptOwner) => Promise<Reply>;
  write: (owner: CloudTranscriptOwner, window: CachedTranscriptWindow, cacheEpoch: string, historyEpoch?: string) => Promise<unknown>;
  prune: (scope: CloudTranscriptPrune) => Promise<unknown>;
  onRestoreHead?: (owner: CloudTranscriptOwner, fence: CloudHistoryRestoreFence) => void;
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
  private readonly fenceFlights = new Map<string, Promise<void>>();
  private readonly maxEntries: number;
  constructor(private readonly dependencies: Dependencies) { this.maxEntries = dependencies.maxEntries ?? 64; }
  setAccount(account: string | null): void {
    this.generation++;
    this.account = account;
    this.tokens.clear(); this.windows.clear(); this.flights.clear(); this.fenceFlights.clear();
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
  restoreHead(owner: CloudTranscriptOwner): CloudHistoryRestoreFence | undefined {
    const parsed = CloudTranscriptOwnerSchema.safeParse(owner);
    if (!parsed.success) return undefined;
    const token = this.tokens.get(transcriptCacheKey(parsed.data));
    return token && this.current(token) ? token.restoreHead : undefined;
  }
  peek(owner: CloudTranscriptOwner): CachedTranscriptWindow | null {
    const parsed = CloudTranscriptOwnerSchema.safeParse(owner);
    if (!parsed.success) return null;
    const key = transcriptCacheKey(parsed.data), token = this.tokens.get(key), entry = this.windows.get(key);
    if (!token || !this.current(token) || !entry || !this.acceptsWindow(token, entry.window)) return null;
    this.windows.delete(key); this.windows.set(key, entry);
    return entry.window;
  }
  private acceptsWindow(token: Token, window: CachedTranscriptWindow): boolean {
    return token.restoreHead ? !!window.restoreHead && cloudHistoryFenceHasTranscript(token.restoreHead) &&
      cloudHistoryFencesMatch(token.restoreHead, window.restoreHead) : !window.restoreHead;
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
        // A retired read may supply its old main nonce to the installing fence,
        // but can never publish a window or mutate the replacement token.
        if (!this.current(token)) return parsed;
        token.cacheEpoch = parsed.cacheEpoch;
        if (parsed.restoreHead) {
          this.assertFenceOwner(token.owner, parsed.restoreHead);
          // Disk is provisional. Its nonce/window may confirm this exact CP
          // fence, but cannot publish another writer or a purported repair.
          if (token.authoritativeHead && token.restoreHead && !cloudHistoryFencesMatch(token.restoreHead, parsed.restoreHead)) return parsed;
          if (token.restoreHead && !cloudHistoryFenceCanAdvance(token.restoreHead, parsed.restoreHead)) return parsed;
          if (!token.restoreHead || !cloudHistoryFencesMatch(token.restoreHead, parsed.restoreHead)) this.windows.delete(key);
          if (!token.authoritativeHead) {
            const changed = !token.restoreHead || !cloudHistoryFencesMatch(token.restoreHead, parsed.restoreHead);
            token.restoreHead = parsed.restoreHead;
            if (changed) {
              try { this.dependencies.onRestoreHead?.(token.owner, token.restoreHead); } catch { /* Provisional observation is passive. */ }
            }
          }
        } else if (token.restoreHead) return parsed;
        if (parsed.historyEpoch) token.historyEpoch = parsed.historyEpoch;
        if (parsed.window && this.acceptsWindow(token, parsed.window)) this.remember(token, prepareCachedTranscriptWindow(parsed.window));
        return parsed;
      } catch { return null; }
    })().finally(() => { if (this.flights.get(key) === request) this.flights.delete(key); });
    this.flights.set(key, request);
    return request;
  }
  private assertFenceOwner(owner: CloudTranscriptOwner, fence: CloudHistoryRestoreFence): void {
    if (fence.conversationId !== owner.chatId || fence.projection.organizationId !== owner.organizationId ||
        fence.projection.workspaceId !== owner.workspaceId) throw new Error("Cloud restore head belongs to another owner.");
  }
  /** Retire paint and in-flight confirmations before awaiting the durable
   * per-chat compare-and-set. A failed cache I/O never restores older paint. */
  async installRestoreHead(owner: CloudTranscriptOwner, input: CloudHistoryRestoreFence): Promise<void> {
    const fence = CloudHistoryRestoreFenceSchema.parse(input), previous = this.capture(owner);
    if (!previous) return;
    this.assertFenceOwner(previous.owner, fence);
    if (previous.restoreHead && !cloudHistoryFenceCanAdvance(previous.restoreHead, fence)) return;
    if (previous.restoreHead && cloudHistoryFencesMatch(previous.restoreHead, fence)) {
      previous.restoreHead = fence; previous.authoritativeHead = true; return;
    }
    const key = transcriptCacheKey(previous.owner), pending = this.fenceFlights.get(key);
    this.forget(key);
    const token: Token = { owner: previous.owner, generation: this.generation, restoreHead: fence, authoritativeHead: true };
    this.tokens.set(key, token);
    const flight = (async () => {
      try {
        await pending;
        if (!this.current(token)) return;
        // Read after the prior fence commits: its old nonce cannot install the
        // successor. Each conversation has its own independent chain.
        const receipt = replySchema.parse(await this.dependencies.read(token.owner));
        if (!this.current(token)) return;
        token.cacheEpoch = receipt.cacheEpoch;
        const result = await this.dependencies.prune({ ...token.owner, restoreHead: fence, cacheEpoch: receipt.cacheEpoch,
          ...(receipt.historyEpoch ? { historyEpoch: receipt.historyEpoch } : {}) });
        if (!this.current(token)) return;
        const installed = replySchema.safeParse(result);
        if (installed.success && installed.data.restoreHead && cloudHistoryFencesMatch(fence, installed.data.restoreHead)) {
          token.cacheEpoch = installed.data.cacheEpoch;
          if (installed.data.historyEpoch) token.historyEpoch = installed.data.historyEpoch;
        }
      } catch { /* The renderer fence remains authoritative even if optional disk I/O fails. */ }
    })().finally(() => { if (this.fenceFlights.get(key) === flight) this.fenceFlights.delete(key); });
    this.fenceFlights.set(key, flight);
    await flight;
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
    if (!this.acceptsWindow(token, window)) return;
    if (previous && previous.recordEpoch === window.recordEpoch && previous.revision > window.revision) return;
    const remembered = this.remember(token, window);
    if (!token.cacheEpoch || token.restoreHead && !token.historyEpoch) await this.receipt(token);
    if (!this.current(token) || !token.cacheEpoch || this.peek(token.owner) !== remembered) return;
    if (token.restoreHead && !token.historyEpoch) return;
    try {
      if (token.historyEpoch) await this.dependencies.write(token.owner, remembered, token.cacheEpoch, token.historyEpoch);
      else await this.dependencies.write(token.owner, remembered, token.cacheEpoch);
    } catch { /* Durable caching is optional. */ }
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
export type CloudHistoryRestoreScope = Omit<CloudTranscriptOwner, "chatId">;
const restoreScopeSchema = CloudTranscriptOwnerSchema.omit({ chatId: true });
type RestoreWorkspace = {
  scope: CloudHistoryRestoreScope;
  binding: string | null;
  heads: Map<string, CloudHistoryRestoreFence>;
  retiredBindings: Set<string>;
};
export type CloudHistoryRestoreTicket = {
  scope: CloudHistoryRestoreScope;
  generation: number;
  workspace: RestoreWorkspace;
};
const restoreWorkspaceKey = (scope: CloudHistoryRestoreScope) => JSON.stringify([scope.accountId, scope.organizationId, scope.workspaceId]);

/** No transport or auth authority. The independently authorized caller supplies
 * the account/scope and captures ownership before starting a passive read.
 * Post-await checks cover promises that a keyed cache returns after retirement. */
export class CloudHistoryRestoreTracker {
  private account: string | null = null;
  private generation = 0;
  private readonly workspaces = new Map<string, RestoreWorkspace>();
  private readonly listeners = new Set<(scope: CloudHistoryRestoreScope, heads: readonly CloudHistoryRestoreFence[]) => void>();
  setAccount(account: string | null): void {
    this.account = account; this.generation++; this.workspaces.clear();
  }
  capture(input: CloudHistoryRestoreScope): CloudHistoryRestoreTicket | null {
    const parsed = restoreScopeSchema.safeParse(input);
    if (!parsed.success || parsed.data.accountId !== this.account) return null;
    const scope = parsed.data, key = restoreWorkspaceKey(scope);
    let workspace = this.workspaces.get(key);
    if (!workspace) {
      workspace = { scope, binding: null, heads: new Map(), retiredBindings: new Set() };
      this.workspaces.set(key, workspace);
      while (this.workspaces.size > 32) this.workspaces.delete(this.workspaces.keys().next().value!);
    }
    return { scope, generation: this.generation, workspace };
  }
  private current(ticket: CloudHistoryRestoreTicket): RestoreWorkspace {
    const workspace = this.workspaces.get(restoreWorkspaceKey(ticket.scope));
    if (ticket.generation !== this.generation || ticket.scope.accountId !== this.account || !workspace)
      throw new Error("Cloud restore read was retired.");
    return workspace;
  }
  private metadata(ticket: CloudHistoryRestoreTicket, input: CloudHistoryRestoreMetadata): CloudHistoryRestoreMetadata {
    const metadata = CloudHistoryRestoreMetadataSchema.parse(input);
    if (metadata.projection.organizationId !== ticket.scope.organizationId ||
        metadata.projection.workspaceId !== ticket.scope.workspaceId) throw new Error("Cloud restore belongs to another workspace.");
    return metadata;
  }
  install(ticket: CloudHistoryRestoreTicket, input: CloudHistoryRestoreMetadata, conversations: readonly string[] = []): readonly CloudHistoryRestoreFence[] {
    const workspace = this.current(ticket), metadata = this.metadata(ticket, input), binding = cloudHistoryBindingKey(metadata.projection);
    if (workspace.retiredBindings.has(binding) || workspace !== ticket.workspace && workspace.binding !== binding)
      throw new Error("Cloud restore writer was retired.");
    const changingBinding = workspace.binding !== null && workspace.binding !== binding;
    if (changingBinding && workspace.retiredBindings.size >= 64) throw new Error("Cloud restore writer history exceeded its bound.");
    const original = changingBinding ? new Map<string, CloudHistoryRestoreFence>() : workspace.heads;
    const heads = new Map(original), supplied = new Map(metadata.historyHeads.map(head => [head.conversationId, head]));
    const changes: CloudHistoryRestoreFence[] = [];
    for (const conversationId of new Set([...supplied.keys(), ...conversations, ...(changingBinding ? workspace.heads.keys() : [])])) {
      const next = CloudHistoryRestoreFenceSchema.parse({ projection: metadata.projection,
        conversationId, head: supplied.get(conversationId) ?? null });
      const previous = heads.get(conversationId);
      if (previous && !cloudHistoryFenceCanAdvance(previous, next)) continue;
      heads.set(conversationId, next);
      if (!previous || !cloudHistoryFencesMatch(previous, next)) changes.push(next);
    }
    if (heads.size > 512) throw new Error("Cloud restore heads exceeded their bound.");
    // Validate the whole page before changing any visible state.
    if (workspace.binding !== binding) {
      const retiredBindings = new Set(workspace.retiredBindings);
      if (workspace.binding) retiredBindings.add(workspace.binding);
      this.workspaces.set(restoreWorkspaceKey(ticket.scope), { scope: ticket.scope, binding, heads, retiredBindings });
    } else workspace.heads = heads;
    for (const listener of this.listeners) {
      try { listener(ticket.scope, changes); } catch { /* A passive subscriber cannot undo accepted authority. */ }
    }
    return changes;
  }
  assertResult(ticket: CloudHistoryRestoreTicket, input: CloudHistoryRestoreMetadata | null, conversations: readonly string[] = []): void {
    const workspace = this.current(ticket);
    if (!input) {
      if (workspace.binding !== null || workspace !== ticket.workspace) throw new Error("Cloud restore response was retired.");
      return;
    }
    const metadata = this.metadata(ticket, input);
    if (workspace.binding !== cloudHistoryBindingKey(metadata.projection)) throw new Error("Cloud restore writer was retired.");
    const supplied = new Map(metadata.historyHeads.map(head => [head.conversationId, head]));
    for (const conversationId of new Set([...supplied.keys(), ...conversations])) {
      const actual = workspace.heads.get(conversationId), head = supplied.get(conversationId) ?? null;
      if (!actual || !cloudHistoryFencesMatch(actual, { projection: metadata.projection, conversationId, head }))
        throw new Error("Cloud restore response no longer matches the current head.");
    }
  }
  head(input: CloudHistoryRestoreScope, conversationId: string): CloudHistoryRestoreFence | undefined {
    const scope = restoreScopeSchema.safeParse(input);
    if (!scope.success || scope.data.accountId !== this.account) return undefined;
    return this.workspaces.get(restoreWorkspaceKey(scope.data))?.heads.get(conversationId);
  }
  subscribe(listener: (scope: CloudHistoryRestoreScope, heads: readonly CloudHistoryRestoreFence[]) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
}
