import { randomUUID } from "node:crypto";
import {
  CloudCacheDeltaSchema, CloudCachePendingSchema, CloudCacheRangeSchema, CloudCacheTargetSchema, cloudCacheKey,
  type CloudCacheDelta, type CloudCacheKey, type CloudCachePending, type CloudCacheRange, type CloudCacheTarget,
} from "../../shared/cloud-chat-cache";
import type { CloudChatCacheStore } from "./store";

export class CloudCacheAccessLost extends Error {
  constructor(readonly scope: "workspace" | "chat" = "workspace") { super("Cloud history access ended."); }
}
export class CloudCacheUnsupported extends Error {
  constructor() { super("Cloud history cache is unavailable on this server."); }
}
export class CloudCacheChanged extends Error {
  constructor() { super("Cloud cache owner or read changed."); }
}
export interface CloudCacheRequestContext { session: string; signal: AbortSignal; current(): void }
export interface CloudChatCacheSource {
  workspace(target: CloudCacheKey, context: CloudCacheRequestContext): Promise<{ id: string; organizationId: string }>;
  range(target: CloudCacheKey, fromIndex: number, toIndex: number, context: CloudCacheRequestContext): Promise<CloudCacheRange>;
  since(target: CloudCacheKey, revision: number, context: CloudCacheRequestContext): Promise<CloudCacheDelta>;
  pending(target: CloudCacheKey, context: CloudCacheRequestContext): Promise<CloudCachePending | null>;
}
interface Binding { owner: string; session: string; client: string; lease: string; stop: AbortController }
interface Refresh { range: CloudCacheRange; replaced: boolean }
interface Flight<T> {
  key: CloudCacheKey; owner: string; session: string; variant: string; stop: AbortController;
  readers: Map<Binding, Promise<T>>; result: Promise<T>;
}
const changed = () => new CloudCacheChanged();
const unavailable = () => new Error("Cloud history cache unavailable.");

export class CloudChatCacheService {
  private readonly bindings = new Map<number, Binding>();
  private readonly flights = new Map<string, Flight<Refresh>>();
  private readonly pendingFlights = new Map<string, Flight<CloudCachePending | null>>();
  private readonly beforeFlights = new Map<string, Flight<CloudCacheRange | null>>();
  private closed = false;
  constructor(private readonly deps: {
    store: CloudChatCacheStore; source: CloudChatCacheSource;
    identity(): { owner: string; session: string } | null;
  }) {}

  bind(window: number, owner: string, client: string): string {
    const identity = this.deps.identity();
    if (this.closed || !identity || identity.owner !== owner || !client || client.length > 128) throw changed();
    const previous = this.bindings.get(window);
    if (previous?.owner === owner && previous.session === identity.session && previous.client === client && !previous.stop.signal.aborted) return previous.lease;
    this.release(window);
    this.deps.store.bindAccount(owner, identity.session);
    const next: Binding = { ...identity, client, lease: randomUUID(), stop: new AbortController() };
    this.bindings.set(window, next);
    return next.lease;
  }

  private binding(window: number, lease: string): Binding {
    const binding = this.bindings.get(window), identity = this.deps.identity();
    if (this.closed || !binding || binding.lease !== lease || binding.stop.signal.aborted ||
      identity?.owner !== binding.owner || identity.session !== binding.session) throw changed();
    return binding;
  }
  private key(binding: Binding, target: CloudCacheTarget): CloudCacheKey { return { owner: binding.owner, ...CloudCacheTargetSchema.parse(target) }; }

  release(window: number): void {
    const binding = this.bindings.get(window);
    binding?.stop.abort(); this.bindings.delete(window);
    this.deps.store.protect(String(window), null);
    if (binding) for (const flights of [this.flights, this.pendingFlights, this.beforeFlights]) for (const [key, flight] of flights) {
      flight.readers.delete(binding);
      if (!flight.readers.size) { flight.stop.abort(); flights.delete(key); }
    }
  }
  unbind(window: number, lease: string): void { this.binding(window, lease); this.release(window); }
  sessionChanged(): void { for (const window of this.bindings.keys()) this.release(window); }
  retireOwner(owner: string, session?: string): void {
    for (const [window, binding] of this.bindings) if (binding.owner === owner &&
      (session === undefined || binding.session === session)) this.release(window);
    this.deps.store.retireOwner(owner, session);
  }
  close(): void { this.sessionChanged(); this.closed = true; }

  read(window: number, lease: string, target: CloudCacheTarget, limit: number): CloudCacheRange | null {
    const binding = this.binding(window, lease), key = this.key(binding, target);
    return this.deps.store.readTail(key, limit);
  }
  readBefore(window: number, lease: string, target: CloudCacheTarget, revision: number, before: string, limit: number): CloudCacheRange | null {
    const key = this.key(this.binding(window, lease), target);
    return this.deps.store.readBefore(key, revision, before, limit);
  }
  readPending(window: number, lease: string, target: CloudCacheTarget): CloudCachePending | null {
    return this.deps.store.readPending(this.key(this.binding(window, lease), target));
  }
  list(window: number, lease: string, after: string | null): { items: CloudCacheTarget[]; nextAfter: string | null } {
    return this.deps.store.list(this.binding(window, lease).owner, after);
  }
  protect(window: number, lease: string, target: CloudCacheTarget | null): void {
    const binding = this.binding(window, lease);
    this.deps.store.protect(String(window), target && this.key(binding, target));
  }
  private cancel(keep: (flight: Flight<unknown>) => boolean): void {
    for (const flights of [this.flights, this.pendingFlights, this.beforeFlights]) for (const [id, flight] of flights)
      if (!keep(flight)) { flight.stop.abort(); flights.delete(id); }
  }
  forget(window: number, lease: string, target: CloudCacheTarget): void {
    const key = this.key(this.binding(window, lease), target), id = cloudCacheKey(key);
    this.cancel(flight => cloudCacheKey(flight.key) !== id);
    this.deps.store.forget(key);
  }

  private subscribe<T>(window: number, lease: string, owner: Binding, flight: Flight<T>): Promise<T> {
    const previous = flight.readers.get(owner);
    if (previous) return previous;
    const current = () => { if (this.binding(window, lease) !== owner) throw changed(); };
    const result = flight.result.then(value => { current(); return value; }, error => { current(); throw error; });
    flight.readers.set(owner, result);
    return result;
  }

  refresh(window: number, lease: string, target: CloudCacheTarget, limit: number): Promise<Refresh> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return Promise.reject(unavailable());
    return this.start(window, lease, target, this.flights, String(limit), (key, context) => this.update(key, limit, context));
  }

  refreshPending(window: number, lease: string, target: CloudCacheTarget): Promise<CloudCachePending | null> {
    return this.start(window, lease, target, this.pendingFlights, "receipts", async (key, context) => {
      await this.workspace(key, context);
      const value = await this.deps.source.pending(key, context); context.current();
      if (value === null) return null;
      const pending = CloudCachePendingSchema.parse(value);
      this.deps.store.putPending(key, pending);
      context.current();
      return pending;
    });
  }

  refreshBefore(window: number, lease: string, target: CloudCacheTarget, before: string, limit: number): Promise<CloudCacheRange | null> {
    if (!before || before.length > 256 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) return Promise.reject(unavailable());
    return this.start(window, lease, target, this.beforeFlights, JSON.stringify([before, limit]), async (key, context) => {
      await this.workspace(key, context);
      const saved = this.deps.store.metadata(key), index = this.deps.store.cursorIndex(key, before);
      if (!saved || index === null) return null;
      const from = Math.max(0, index - limit);
      const page = CloudCacheRangeSchema.parse(await this.deps.source.range(key, from, index, context)); context.current();
      if (page.revision !== saved.revision || page.messageCount !== saved.messageCount || page.fromIndex !== from || page.toIndex !== index ||
        this.deps.store.metadata(key)?.revision !== saved.revision) return null;
      this.deps.store.putRange(key, page);
      return page;
    });
  }

  private start<T>(window: number, lease: string, target: CloudCacheTarget, flights: Map<string, Flight<T>>, variant: string,
    update: (key: CloudCacheKey, context: CloudCacheRequestContext) => Promise<T>): Promise<T> {
    let owner: Binding, key: CloudCacheKey;
    try {
      owner = this.binding(window, lease); key = this.key(owner, target);
    } catch (error) { return Promise.reject(error); }
    const id = cloudCacheKey(key);
    const previous = flights.get(id);
    if (previous?.variant === variant && previous.session === owner.session) return this.subscribe(window, lease, owner, previous);
    if (previous) { previous.stop.abort(); flights.delete(id); }
    const flight: Flight<T> = { key, owner: owner.owner, session: owner.session, variant,
      stop: new AbortController(), readers: new Map(), result: undefined! };
    const current = () => {
      const identity = this.deps.identity();
      if (this.closed || identity?.owner !== flight.owner || identity.session !== flight.session ||
        flights.get(id) !== flight || flight.stop.signal.aborted) throw changed();
    };
    const context = { session: owner.session, signal: flight.stop.signal, current };
    flights.set(id, flight);
    flight.result = update(key, context).catch(error => {
      current();
      if (error instanceof CloudCacheAccessLost) {
        if (error.scope === "chat") {
          this.cancel(other => cloudCacheKey(other.key) !== cloudCacheKey(key)); this.deps.store.forget(key);
        } else {
          this.cancel(other => other.key.owner !== key.owner || other.key.organizationId !== key.organizationId || other.key.workspaceId !== key.workspaceId);
          this.deps.store.forgetWorkspace(key.owner, key.organizationId, key.workspaceId);
        }
      }
      throw error;
    }).finally(() => { if (flights.get(id) === flight) flights.delete(id); });
    return this.subscribe(window, lease, owner, flight);
  }

  private async workspace(key: CloudCacheKey, context: CloudCacheRequestContext): Promise<void> {
    context.current();
    const workspace = await this.deps.source.workspace(key, context); context.current();
    if (workspace.id !== key.workspaceId || workspace.organizationId !== key.organizationId) throw unavailable();
  }

  private async update(key: CloudCacheKey, limit: number, context: CloudCacheRequestContext): Promise<Refresh> {
    await this.workspace(key, context);
    let metadata = this.deps.store.metadata(key), replaced = false;
    if (metadata) {
      const delta = CloudCacheDeltaSchema.parse(await this.deps.source.since(key, metadata.revision, context)); context.current();
      if (delta.resync) {
        if (!this.deps.store.applyDelta(key, delta, metadata.revision)) throw changed();
        const id = cloudCacheKey(key);
        for (const flights of [this.pendingFlights, this.beforeFlights]) {
          flights.get(id)?.stop.abort(); flights.delete(id);
        }
        replaced = true;
      } else if (delta.fromRevision !== metadata.revision || !this.deps.store.applyDelta(key, delta)) {
        throw unavailable();
      }
      metadata = { revision: delta.revision, messageCount: delta.messageCount };
    } else {
      const probe = CloudCacheRangeSchema.parse(await this.deps.source.range(key, 0, 0, context)); context.current();
      if (probe.fromIndex !== 0 || probe.toIndex !== 0) throw unavailable();
      metadata = probe;
    }
    const from = Math.max(0, metadata.messageCount - limit);
    const cached = this.deps.store.readRange(key, from, metadata.messageCount);
    if (cached?.revision === metadata.revision) { context.current(); return { range: cached, replaced }; }
    const page = CloudCacheRangeSchema.parse(await this.deps.source.range(key, from, metadata.messageCount, context)); context.current();
    if (page.revision !== metadata.revision || page.fromIndex !== from || page.toIndex !== metadata.messageCount || page.messageCount !== metadata.messageCount) throw unavailable();
    this.deps.store.putRange(key, page);
    context.current();
    if ((this.deps.store.metadata(key)?.revision ?? page.revision) > page.revision) throw changed();
    return { range: page, replaced };
  }
}
