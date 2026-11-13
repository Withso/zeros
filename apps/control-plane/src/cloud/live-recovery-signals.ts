import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { withSystemTx } from "../db.js";
import { postgresNotificationSubscription, type PostgresNotificationSubscription } from "../postgres-notifications.js";

const CHANNEL = "zeros_cloud_live_recovery";
const Binding = z.object({ workspaceId: z.uuid(), bootId: z.uuid(), sandboxId: z.string().regex(/^bx_[a-z0-9]{4,32}$/),
  accessEpoch: z.string().regex(/^\d{1,20}$/) });
const Notice = z.discriminatedUnion("type", [
  Binding.extend({ type: z.literal("watch"), id: z.uuid(), expiresAt: z.number().safe().int() }).strict(),
  z.object({ type: z.literal("proof"), id: z.uuid() }).strict(),
]);
export type LiveRecoveryProofBinding = z.infer<typeof Binding>;
export type LiveRecoveryWitness = { seen(): boolean; dispose(): void };
type Watch = LiveRecoveryProofBinding & { expiresAt: number; seen: boolean; local: boolean };

/** Availability evidence only: each challenge requires a newly authenticated
 * outbound request. Binding/authority is re-read before every repair effect.
 * Healthy polls with no challenge do no extra database work. */
export class LiveRecoverySignals {
  private readonly subscription: PostgresNotificationSubscription;
  private readonly watches = new Map<string, Watch>();
  private readonly sending = new Set<Promise<void>>();
  private closed = false;
  private revision = 0;
  constructor(private readonly pool: pg.Pool, listenerPool: pg.Pool, private readonly now = Date.now) {
    this.subscription = postgresNotificationSubscription(listenerPool, {
      channels: [CHANNEL], onDisconnect: () => { this.revision++; this.watches.clear(); },
      onNotification: AsyncResource.bind(notice => this.receive(notice.payload), "cloud-live-recovery-proof"),
    });
  }
  start() { return this.subscription.start(); }
  async stop() {
    this.closed = true; this.revision++; this.watches.clear();
    await this.subscription.stop(); await Promise.all([...this.sending]);
  }
  private prune() { for (const [id, watch] of this.watches) if (watch.expiresAt < this.now()) this.watches.delete(id); }
  private send(value: z.infer<typeof Notice>): Promise<void> {
    const flight = withSystemTx(this.pool, async tx => { await tx.query("SELECT pg_notify($1,$2)", [CHANNEL, JSON.stringify(value)]); })
      .catch(() => { if (value.type === "watch") this.watches.delete(value.id); });
    this.sending.add(flight); void flight.finally(() => this.sending.delete(flight)); return flight;
  }
  private receive(payload: string | undefined) {
    if (this.closed || !payload || payload.length > 512) return;
    let input: unknown; try { input = JSON.parse(payload); } catch { return; }
    const parsed = Notice.safeParse(input); if (!parsed.success) return;
    this.prune(); const value = parsed.data;
    if (value.type === "proof") {
      const watch = this.watches.get(value.id); if (watch?.local) watch.seen = true;
    } else if (!this.watches.has(value.id) && this.watches.size < 1024 && value.expiresAt > this.now() && value.expiresAt <= this.now() + 65_000) {
      this.watches.set(value.id, { ...value, seen: false, local: false });
    }
  }
  async watch(binding: LiveRecoveryProofBinding, expiresAt: number): Promise<LiveRecoveryWitness> {
    this.prune(); const id = randomUUID(), revision = this.revision;
    const watch: Watch = { ...binding, expiresAt, seen: false, local: true };
    if (!this.closed && this.subscription.healthy() && this.watches.size < 1024 && Binding.safeParse(binding).success &&
        expiresAt > this.now() && expiresAt <= this.now() + 60_000) {
      this.watches.set(id, watch);
      await this.send({ type: "watch", id, ...binding, expiresAt });
    }
    return { seen: () => this.subscription.healthy() && revision === this.revision && watch.seen,
      dispose: () => { this.watches.delete(id); } };
  }
  async worker(binding: LiveRecoveryProofBinding): Promise<void> {
    if (this.closed || !this.subscription.healthy()) return;
    this.prune(); const replies: Promise<void>[] = [];
    for (const [id, watch] of this.watches) {
      if (watch.seen || watch.workspaceId !== binding.workspaceId || watch.bootId !== binding.bootId ||
          watch.sandboxId !== binding.sandboxId || watch.accessEpoch !== binding.accessEpoch) continue;
      watch.seen = true;
      if (!watch.local) this.watches.delete(id);
      replies.push(this.send({ type: "proof", id }));
    }
    await Promise.all(replies);
  }
}
