import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { type CloudV2BootCleanRefusal, CloudV2BootCleanReplySchema, CloudV2BootCleanRequestSchema, CloudV2BootstrapLeaseSchema, CloudV2ClientLeaseSchema, CloudV2RenewReplySchema, CloudV2RetiredReplySchema, CloudV2TerminalLeaseSchema,
  CloudV2TurnLeaseSchema, type CloudV2BootstrapLease, type CloudV2ClientLease, type CloudV2ContextReason, type CloudV2TerminalLease,
  type CloudV2TurnLease } from "@zeros/protocol/cloud-v2-relay";

/** Worker → control plane POST to /v2/cloud/worker/<path> (worker bearer + boot); throws with `status` on a non-2xx reply. */
export interface ContextsDeps {
  post(path: string, body: unknown): Promise<unknown>;
  now?(): number;
  /** Renewal cadence override (tests). */
  renewMs?: number;
}
type Lease = CloudV2TurnLease | CloudV2TerminalLease | CloudV2ClientLease | CloudV2BootstrapLease;
type RetirementReason = "outcome" | "stop" | "revoked" | "generation_changed" | "terminal_closed" | "operation_done" | "expired" | "setup_done";
interface Entry { lease: Lease; expiresAt: number; ended?: CloudV2ContextReason; listeners: Set<(reason: CloudV2ContextReason) => void>; retirementId?: string; retired?: boolean;
  /** Ends the context at its own deadline, between renewal ticks (J-3A1). */
  deadline?: ReturnType<typeof setTimeout> }

/** Renewal cadence (team-sharing-2-wire.md Slice B shapes 6): one batch every 10 s while any context lives. */
export const CONTEXT_RENEW_MS = 10_000;
const MAX_BATCH = 128;

/** Team sharing slice B: the execution contexts this worker holds, in memory
 * only. A context's personal material lives as long as its lease: renewed in
 * one batch, ended at once by a refusal, a revoke-context push or its own
 * deadline (a failed renewal never extends it). Nothing here chooses a person:
 * the control plane names the context and the worker only asks for it. */
export class ExecutionContexts {
  private readonly entries = new Map<string, Entry>();
  private timer?: ReturnType<typeof setInterval>;
  private gate?: Promise<void>;
  constructor(private readonly deps: ContextsDeps) {}

  /** §7a: this boot's clean attestation, once. Every lease waits for it; unproven cleanup (or a refused receipt) grants none. */
  clean(attest: () => Promise<number | { processes: number; legacyMaterial: "none" | "removed" | "refused"; refusals?: readonly CloudV2BootCleanRefusal[] }>): Promise<void> {
    this.gate ??= (async () => {
      const proof = await attest().catch(() => ({ processes: 1, legacyMaterial: "refused" as const, refusals: ["io_error"] as const }));
      const { processes, legacyMaterial, refusals = [] } = typeof proof === "number" ? { processes: proof, legacyMaterial: undefined } : proof;
      const retirementId = randomUUID(), classes = [...new Set(refusals)].sort();
      const proposed = { retirementId, processes, ...(legacyMaterial ? { legacyMaterial } : {}), ...(classes.length ? { refusals: classes } : {}) };
      // The shared schema decides what is consistent; anything it refuses goes as unproven, refused material.
      const body = CloudV2BootCleanRequestSchema.safeParse(proposed).success ? proposed
        : { retirementId, processes: Math.max(1, processes), legacyMaterial: "refused" as const, refusals: ["io_error" as const] };
      for (let attempt = 0; ; attempt++) {
        try { CloudV2BootCleanReplySchema.parse(await this.deps.post("execution-leases/boot-clean", body)); break; }
        catch (error) {
          const status = (error as { status?: unknown }).status;
          if (typeof status === "number" && status >= 400 && status < 500 && status !== 408) throw error;
          if (attempt >= 4) throw error;
          await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
        }
      }
      // What was attested decides, including a fallback for an inconsistent proof.
      if (body.processes > 0 || body.legacyMaterial === "refused") throw new Error("This workspace could not prove a clean start.");
    })();
    void this.gate.catch(() => {});
    return this.gate;
  }
  /** Resolves once this boot may act for people (immediately when no attestation is required). */
  ready(): Promise<void> { return this.gate ?? Promise.resolve(); }
  private now(): number { return this.deps.now?.() ?? Date.now(); }

  turnLease(request: { chatId: string; userMessageId: string; dispatchId: string; generation: string; contextId: string }): Promise<CloudV2TurnLease> {
    return this.lease("turn-lease", request, request.contextId, CloudV2TurnLeaseSchema);
  }
  terminalLease(request: { clientId: string; terminalId: string; requestId: string }): Promise<CloudV2TerminalLease> {
    return this.lease("terminal-lease", request, undefined, CloudV2TerminalLeaseSchema);
  }
  clientLease(request: { clientId: string; requestId: string; operation: string }): Promise<CloudV2ClientLease> {
    return this.lease("client-lease", request, undefined, CloudV2ClientLeaseSchema);
  }
  bootstrapLease(contextId: string): Promise<CloudV2BootstrapLease> {
    return this.lease("bootstrap-lease", { contextId }, contextId, CloudV2BootstrapLeaseSchema);
  }

  private async lease<T extends Lease>(route: string, body: unknown, expected: string | undefined, schema: z.ZodType<T>): Promise<T> {
    await this.ready();
    const lease = schema.parse(await this.deps.post(route, body));
    if (expected !== undefined && lease.contextId !== expected) throw new Error("The control plane answered for another context.");
    const known = this.entries.get(lease.contextId);
    if (known?.ended) throw new Error("This context has ended.");
    if (known) { known.lease = lease; this.expire(lease.contextId, known, lease.expiresAt); }
    else this.track(lease.contextId, { lease, expiresAt: lease.expiresAt, listeners: new Set() });
    this.arm();
    return lease;
  }

  /** An open connection's client context (open.userId/contextId, control-plane authored): no lease reply, the
   * same 30 s life, renewed in every batch while the connection stays open. */
  adopt(contextId: string, userId: string): void {
    if (this.entries.has(contextId)) return;
    const expiresAt = this.now() + 30_000;
    this.track(contextId, { lease: { contextId, userId, expiresAt, gitIdentity: null }, expiresAt, listeners: new Set() });
    this.arm();
  }
  /** sync-context-v1: a sync socket's handle is used only after one successful renewal (after the clean boot), with exactly the deadline it returns. */
  async admitHandle(contextId: string, userId: string): Promise<boolean> {
    try { await this.ready(); } catch { return false; }
    let reply: z.infer<typeof CloudV2RenewReplySchema>;
    try { reply = CloudV2RenewReplySchema.parse(await this.deps.post("execution-leases/renew", { contextIds: [contextId] })); }
    catch { return false; }
    const result = reply.leases.find(lease => lease.contextId === contextId);
    if (!result || "refused" in result) return false;
    const known = this.entries.get(contextId);
    if (known?.ended) return false;
    if (known) this.expire(contextId, known, result.expiresAt);
    else this.track(contextId, { lease: { contextId, userId, expiresAt: result.expiresAt, gitIdentity: null }, expiresAt: result.expiresAt, listeners: new Set() });
    this.arm();
    return true;
  }
  /** The connection closed: the handle stops renewing and lapses on the control plane (nothing it owns is retired). */
  release(contextId: string): void {
    const entry = this.entries.get(contextId);
    if (!entry || entry.retirementId) return;
    this.end(contextId, "client_closed");
    this.entries.delete(contextId);
    this.arm();
  }

  /** A live context: leased, not ended, before its deadline. One found past its deadline ends here, so a late timer never admits a use. */
  live(contextId: string): boolean {
    const entry = this.entries.get(contextId);
    if (entry && !entry.ended && this.now() >= entry.expiresAt) this.end(contextId, "expired");
    return !!entry && !entry.ended;
  }
  expiresAt(contextId: string): number | undefined { return this.entries.get(contextId)?.expiresAt; }
  userOf(contextId: string): string | undefined { const entry = this.entries.get(contextId); return entry && !entry.ended ? entry.lease.userId : undefined; }
  /** Called once when the context ends (refused, revoked, expired); the owner then cleans up and retires it. */
  onEnd(contextId: string, listener: (reason: CloudV2ContextReason) => void): () => void {
    const entry = this.entries.get(contextId);
    if (!entry) return () => {};
    if (entry.ended) { listener(entry.ended); return () => {}; }
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }

  /** revoke-context push, or a local decision: ends it now. */
  revoke(contextId: string, reason: CloudV2ContextReason): void { this.end(contextId, reason); }

  private end(contextId: string, reason: CloudV2ContextReason): void {
    const entry = this.entries.get(contextId);
    if (!entry || entry.ended) return;
    entry.ended = reason;
    clearTimeout(entry.deadline);
    for (const listener of [...entry.listeners]) { try { listener(reason); } catch { /* one owner's cleanup never blocks another's */ } }
    entry.listeners.clear();
  }

  /** One ordered batch for every live context; refusals end theirs; a failed batch extends nothing. */
  async renew(): Promise<void> {
    // §10a: nothing renews before this boot's clean attestation is accepted.
    if (this.gate && !(await this.gate.then(() => true, () => false))) return;
    const now = this.now();
    for (const [contextId, entry] of this.entries) if (!entry.ended && now >= entry.expiresAt) this.end(contextId, "expired");
    const ids = [...this.entries].filter(([, entry]) => !entry.ended).map(([contextId]) => contextId);
    for (let start = 0; start < ids.length; start += MAX_BATCH) {
      const contextIds = ids.slice(start, start + MAX_BATCH);
      let reply: z.infer<typeof CloudV2RenewReplySchema>;
      try { reply = CloudV2RenewReplySchema.parse(await this.deps.post("execution-leases/renew", { contextIds })); }
      catch { continue; }   // 503 or a lost reply: each context keeps only its own deadline
      for (const result of reply.leases) {
        const entry = this.entries.get(result.contextId);
        if (!entry || entry.ended || !contextIds.includes(result.contextId)) continue;
        if ("refused" in result) this.end(result.contextId, result.refused);
        else this.expire(result.contextId, entry, result.expiresAt);
      }
    }
  }

  /** After the owner has killed its processes and removed its handles: the retirement receipt (same id on retry). */
  async retire(contextId: string, reason: RetirementReason, processes: number): Promise<void> {
    const entry = this.entries.get(contextId);
    if (entry && !entry.ended) this.end(contextId, reason === "expired" ? "expired" : reason === "revoked" ? "actor_changed" : "completed");
    const retirementId = entry ? (entry.retirementId ??= randomUUID()) : randomUUID();
    CloudV2RetiredReplySchema.parse(await this.deps.post(`execution-leases/${contextId}/retired`, { retirementId, reason, processes }));
    // Kept (ended, retired) so a repeated receipt reuses its id; the oldest retired entries are pruned.
    if (entry && processes === 0) entry.retired = true;
    const retired = [...this.entries].filter(([, value]) => value.retired);
    for (const [id] of retired.slice(0, Math.max(0, retired.length - 256))) this.entries.delete(id);
    this.arm();
  }

  private track(contextId: string, entry: Entry): void {
    this.entries.set(contextId, entry);
    this.expire(contextId, entry, entry.expiresAt);
  }
  /** The control plane's latest accepted deadline, exactly: it may clamp one shorter (token or source horizon); a failed renewal never calls this. */
  private expire(contextId: string, entry: Entry, expiresAt: number): void {
    entry.expiresAt = expiresAt;
    clearTimeout(entry.deadline);
    if (entry.ended) return;
    entry.deadline = setTimeout(() => { if (this.entries.get(contextId) === entry) this.live(contextId); }, Math.max(0, expiresAt - this.now()));
    entry.deadline.unref?.();
  }

  /** Renewal runs only while contexts exist. */
  private arm(): void {
    const any = [...this.entries.values()].some(entry => !entry.ended);
    if (any && !this.timer) { this.timer = setInterval(() => { void this.renew(); }, this.deps.renewMs ?? CONTEXT_RENEW_MS); this.timer.unref?.(); }
    else if (!any && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
  dispose(): void { clearInterval(this.timer); this.timer = undefined; for (const contextId of [...this.entries.keys()]) this.end(contextId, "worker_changed"); }
}
