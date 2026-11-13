import { z } from "zod";
import {
  CloudCachePendingSchema, CloudCacheRangeSchema, CloudCacheReplySchema, CloudCacheTargetSchema,
  type CloudCachePending, type CloudCacheRange, type CloudCacheReply, type CloudCacheRequest, type CloudCacheTarget,
} from "../../../shared/cloud-chat-cache";

type Failure = Extract<CloudCacheReply, { ok: false }>;
type WithoutLease<T> = T extends { lease: string } ? Omit<T, "lease"> : never;
type Operation = WithoutLease<CloudCacheRequest>;
const snapshotSchema = z.object({ range: CloudCacheRangeSchema.nullable(), pending: CloudCachePendingSchema.nullable() }).strict();
export type NativeCloudCacheSnapshot = z.infer<typeof snapshotSchema>;
const refreshSchema = z.object({ range: CloudCacheRangeSchema, replaced: z.boolean() }).strict();
const listSchema = z.object({ items: z.array(CloudCacheTargetSchema).max(500), nextAfter: z.string().max(16_384).nullable() }).strict();
export class NativeCloudCacheError extends Error {
  constructor(readonly reason: Failure["reason"]) { super("Cloud chat cache unavailable."); }
}
interface Binding {
  owner: string; session: string | undefined; client: string; mutation: number;
  lease?: Promise<string>;
  protected?: CloudCacheTarget | null;
  protection?: Promise<void>;
  appliedProtection?: { lease: string; target: CloudCacheTarget | null };
}
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new NativeCloudCacheError("unavailable");
  return result.data;
}

export class NativeCloudChatCacheClient {
  private binding: Binding | null = null;
  private generation = 0;
  private readonly flights = new Map<string, Promise<unknown>>();
  constructor(private readonly deps: {
    invoke(input: CloudCacheRequest): Promise<unknown>;
    accessLost?(owner: string, target: CloudCacheTarget, scope: "workspace" | "chat"): void;
  }) {}

  get owner(): string | null { return this.binding?.owner ?? null; }
  get epoch(): number { return this.generation; }
  bindOwner(owner: string | null, session?: string): void {
    if (this.binding?.owner === owner && this.binding.session === session || !this.binding && owner === null) return;
    const previous = this.binding;
    this.generation++; this.flights.clear();
    this.binding = owner === null ? null : { owner, session, client: crypto.randomUUID(), mutation: 0 };
    if (previous?.lease) void previous.lease.then(lease => this.deps.invoke({ op: "release", lease })).catch(() => {});
  }
  private current(binding: Binding, mutation = binding.mutation): void {
    if (binding !== this.binding || binding.mutation !== mutation) throw new NativeCloudCacheError("owner_changed");
  }
  private lease(binding: Binding): Promise<string> {
    if (binding.lease) return binding.lease;
    const flight: Promise<string> = (async () => {
      const reply = parsed(CloudCacheReplySchema, await this.deps.invoke({ op: "bind", owner: binding.owner, client: binding.client }));
      if (!reply.ok) throw new NativeCloudCacheError(reply.reason);
      const { lease } = parsed(z.object({ lease: z.string().uuid() }).strict(), reply.result);
      if (binding !== this.binding) {
        void this.deps.invoke({ op: "release", lease }).catch(() => {});
        throw new NativeCloudCacheError("owner_changed");
      }
      return lease;
    })().catch((error: unknown) => {
      if (binding.lease === flight) binding.lease = undefined;
      this.current(binding);
      if (error instanceof NativeCloudCacheError) throw error;
      throw new NativeCloudCacheError("unavailable");
    });
    binding.lease = flight;
    return flight;
  }

  private request<T>(input: Operation, schema: z.ZodType<T>, binding = this.binding): Promise<T> {
    if (!binding) return Promise.reject(new NativeCloudCacheError("owner_changed"));
    const mutation = binding.mutation, key = JSON.stringify([this.generation, mutation, input]);
    const previous = this.flights.get(key);
    if (previous) return previous as Promise<T>;
    if (this.flights.size >= 64) return Promise.reject(new NativeCloudCacheError("unavailable"));
    const flight: Promise<T> = (async () => {
      this.current(binding, mutation);
      let lease: string;
      try { lease = await this.lease(binding); }
      catch (error) { this.current(binding, mutation); throw error; }
      this.current(binding, mutation);
      if (!["protect", "forget", "list", "release"].includes(input.op) && binding.protected !== undefined &&
          (binding.appliedProtection?.lease !== lease || binding.appliedProtection.target !== binding.protected)) {
        await this.protect(binding.protected);
        this.current(binding, mutation);
        if (binding.appliedProtection?.lease !== lease || binding.appliedProtection.target !== binding.protected)
          throw new NativeCloudCacheError("unavailable");
      }
      let raw: unknown;
      try { raw = await this.deps.invoke({ ...input, lease }); }
      catch { this.current(binding, mutation); throw new NativeCloudCacheError("unavailable"); }
      this.current(binding, mutation);
      const reply = parsed(CloudCacheReplySchema, raw);
      if (!reply.ok) {
        if (reply.reason === "owner_changed") binding.lease = undefined;
        if (reply.reason === "access_lost" && "target" in input && input.target) {
          binding.mutation++;
          this.deps.accessLost?.(binding.owner, input.target, reply.scope ?? "workspace");
        }
        throw new NativeCloudCacheError(reply.reason);
      }
      const result = parsed(schema, reply.result);
      if (input.op === "protect") binding.appliedProtection = { lease, target: input.target };
      return result;
    })().finally(() => { if (this.flights.get(key) === flight) this.flights.delete(key); });
    this.flights.set(key, flight);
    return flight;
  }

  read(target: CloudCacheTarget, limit = 200): Promise<NativeCloudCacheSnapshot | null> {
    if (!this.binding) return Promise.resolve(null);
    return this.request({ op: "read", target, limit }, snapshotSchema).then(snapshot => {
      if (snapshot.pending?.items.some(item => item.receipt.workspaceId !== target.workspaceId || item.receipt.chatId !== target.chatId ||
        item.payload && (item.payload.chatId !== target.chatId || item.payload.userMessageId !== item.receipt.userMessageId))) return null;
      return snapshot;
    }).catch(() => null);
  }
  readBefore(target: CloudCacheTarget, revision: number, before: string, limit = 200): Promise<CloudCacheRange | null> {
    return this.request({ op: "read-before", target, revision, before, limit }, CloudCacheRangeSchema.nullable())
      .then(page => page?.revision === revision ? page : null).catch(() => null);
  }
  refresh(target: CloudCacheTarget, limit = 200): Promise<{ range: CloudCacheRange; replaced: boolean }> {
    return this.request({ op: "refresh", target, limit }, refreshSchema);
  }
  refreshBefore(target: CloudCacheTarget, before: string, limit = 200): Promise<CloudCacheRange | null> {
    return this.request({ op: "refresh-before", target, before, limit }, CloudCacheRangeSchema.nullable());
  }
  refreshPending(target: CloudCacheTarget): Promise<CloudCachePending | null> {
    return this.request({ op: "refresh-pending", target }, CloudCachePendingSchema.nullable());
  }
  async forget(targets: CloudCacheTarget[]): Promise<void> {
    const binding = this.binding;
    if (!binding || !targets.length) return;
    binding.mutation++;
    for (let start = 0; start < targets.length; start += 500) {
      this.current(binding);
      await this.request({ op: "forget", targets: targets.slice(start, start + 500) }, z.null(), binding);
    }
  }
  list(after: string | null = null): Promise<z.infer<typeof listSchema>> {
    return this.request({ op: "list", after }, listSchema);
  }
  protect(target: CloudCacheTarget | null): Promise<void> {
    const binding = this.binding;
    if (!binding) return Promise.resolve();
    binding.protected = target;
    if (binding.protection) return binding.protection;
    const flight: Promise<void> = (async () => {
      let current: CloudCacheTarget | null;
      do {
        current = binding.protected ?? null;
        await this.request({ op: "protect", target: current }, z.null(), binding);
        this.current(binding);
      } while (binding.protected !== current);
    })().catch(() => {}).finally(() => { if (binding.protection === flight) binding.protection = undefined; });
    binding.protection = flight;
    return flight;
  }
}
