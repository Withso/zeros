import type pg from "pg";

import { withSystemTx } from "../db.js";

export type UplinkPhase = "starting" | "preparing" | "ready" | "degraded" | "stopping";

/** The full durable state of one uplink connection. Each write carries the
 * whole snapshot, so a retried or coalesced write is idempotent. */
export type UplinkPresenceSnapshot = Readonly<{
  connectionId: string;
  engineInstanceId: string;
  workspaceId: string;
  organizationId: string;
  generation: number;
  realtimeInstance: string;
  protocol: number;
  connected: boolean;
  ready: boolean;
  phase: UplinkPhase | null;
  connectedAtMs: number;
  lastSeenAtMs: number;
  disconnectedAtMs: number | null;
}>;

export interface UplinkPresenceStore {
  write(snapshot: UplinkPresenceSnapshot): Promise<void>;
}

export class DatabaseUplinkPresenceStore implements UplinkPresenceStore {
  constructor(private readonly pool: pg.Pool) {}

  async write(s: UplinkPresenceSnapshot): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      // A write that waits behind a lifecycle lock is retried by the queue
      // rather than holding a pool connection.
      await tx.query("SET LOCAL lock_timeout = '2s'");
      await tx.query(
        `INSERT INTO cloud_workspace_engine_uplinks AS current (
           engine_instance_id, workspace_id, org_id, generation, connection_id, realtime_instance, protocol,
           connected, ready, phase, connected_at, last_seen_at, disconnected_at, updated_at)
         SELECT engine.id, engine.workspace_id, engine.org_id, engine.generation, $5, $6, $7, $8, $9, $10,
           to_timestamp($11::double precision / 1000), to_timestamp($12::double precision / 1000),
           to_timestamp($13::double precision / 1000), clock_timestamp()
         FROM cloud_workspace_engine_instances engine
         WHERE engine.id = $1 AND engine.workspace_id = $2 AND engine.org_id = $3 AND engine.generation = $4
         ON CONFLICT (engine_instance_id) DO UPDATE SET
           connection_id = EXCLUDED.connection_id, realtime_instance = EXCLUDED.realtime_instance,
           protocol = EXCLUDED.protocol, connected = EXCLUDED.connected, ready = EXCLUDED.ready,
           phase = EXCLUDED.phase, connected_at = EXCLUDED.connected_at, last_seen_at = EXCLUDED.last_seen_at,
           disconnected_at = EXCLUDED.disconnected_at, updated_at = clock_timestamp()
         WHERE current.connection_id = EXCLUDED.connection_id OR current.connected_at < EXCLUDED.connected_at`,
        [s.engineInstanceId, s.workspaceId, s.organizationId, s.generation, s.connectionId, s.realtimeInstance,
          s.protocol, s.connected, s.ready, s.phase, s.connectedAtMs, s.lastSeenAtMs, s.disconnectedAtMs],
      );
    });
  }

  /** Recorded owners, read after a missed-notification window. */
  async owners(engineInstanceIds: readonly string[]): Promise<{ engineInstanceId: string; connectionId: string; connectedAtMs: number }[]> {
    if (engineInstanceIds.length === 0) return [];
    const rows = await withSystemTx(this.pool, tx => tx.query<{ engine_instance_id: string; connection_id: string; connected_at_ms: string }>(
      `SELECT engine_instance_id, connection_id, round(extract(epoch FROM connected_at) * 1000)::bigint AS connected_at_ms
       FROM cloud_workspace_engine_uplinks WHERE engine_instance_id = ANY($1::uuid[])`,
      [engineInstanceIds],
    ));
    return rows.rows.map(row => ({ engineInstanceId: row.engine_instance_id, connectionId: row.connection_id,
      connectedAtMs: Number(row.connected_at_ms) }));
  }
}

/** Bounded, coalescing retry queue for presence writes. Only the latest
 * snapshot per connection is kept; a failed write retries with full jitter.
 * No uplink is ever closed because the database is slow or down. */
export class UplinkPresenceWriter {
  private readonly pending = new Map<string, UplinkPresenceSnapshot>();
  private readonly inFlight = new Set<string>();
  private readonly retryAtMs = new Map<string, number>();
  private readonly attempts = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAtMs = 0;
  private closed = false;
  private droppedCount = 0;
  private readonly maxPending: number;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly store: UplinkPresenceStore, options: {
    maxPending?: number; concurrency?: number; now?: () => number; random?: () => number;
  } = {}) {
    this.maxPending = options.maxPending ?? 20_000;
    this.concurrency = options.concurrency ?? 2;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  get size(): number { return this.pending.size; }
  get dropped(): number { return this.droppedCount; }

  enqueue(snapshot: UplinkPresenceSnapshot): void {
    if (this.closed) return;
    if (!this.pending.has(snapshot.connectionId)) {
      while (this.pending.size >= this.maxPending) {
        const oldest = [...this.pending.keys()].find(key => !this.inFlight.has(key));
        if (oldest === undefined) break;
        this.forget(oldest);
        this.droppedCount += 1;
      }
    }
    this.pending.set(snapshot.connectionId, snapshot);
    this.retryAtMs.delete(snapshot.connectionId);
    this.attempts.delete(snapshot.connectionId);
    this.pump();
  }

  /** Waits up to `timeoutMs` for queued writes, then stops. */
  async close(timeoutMs = 2_000): Promise<void> {
    const deadline = this.now() + timeoutMs;
    for (const key of this.retryAtMs.keys()) this.retryAtMs.set(key, 0);
    this.pump();
    while (this.pending.size > 0 && this.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private forget(key: string): void {
    this.pending.delete(key);
    this.retryAtMs.delete(key);
    this.attempts.delete(key);
  }

  private pump(): void {
    if (this.closed) return;
    const now = this.now();
    let nextAt = Infinity;
    for (const [key, snapshot] of this.pending) {
      if (this.inFlight.size >= this.concurrency) return;
      if (this.inFlight.has(key)) continue;
      const at = this.retryAtMs.get(key) ?? 0;
      if (at > now) { nextAt = Math.min(nextAt, at); continue; }
      this.run(key, snapshot);
    }
    if (nextAt !== Infinity && (!this.timer || nextAt < this.timerAtMs)) {
      if (this.timer) clearTimeout(this.timer);
      this.timerAtMs = nextAt;
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, Math.max(1, nextAt - now));
      this.timer.unref?.();
    }
  }

  private run(key: string, snapshot: UplinkPresenceSnapshot): void {
    this.inFlight.add(key);
    void this.store.write(snapshot).then(() => {
      if (this.pending.get(key) === snapshot) this.forget(key);
    }, () => {
      if (this.pending.get(key) !== snapshot) return;
      const attempt = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, attempt);
      const cap = Math.min(30_000, 500 * 2 ** Math.min(attempt, 10));
      this.retryAtMs.set(key, this.now() + Math.floor(this.random() * cap));
    }).finally(() => {
      this.inFlight.delete(key);
      this.pump();
    });
  }
}
