import type pg from "pg";

import { withSystemTx } from "../db.js";
import { postgresNotificationSubscription, type PostgresNotificationSubscription } from "../postgres-notifications.js";
import { publishPendingSecurityEvents, type SecurityEventWire } from "../security-events.js";

export const SECURITY_EVENT_CHANNEL = "zeros_security_event";
const PAGE_SIZE = 500;
/** One wake reads at most this many pages before declaring a gap: a
 * subscriber that falls this far behind re-reads current state instead. */
const MAX_PAGES_PER_WAKE = 10;
const DEFAULT_POLL_MS = 30_000;
const READ_RETRY_MS = 1_000;

/** One published security event, in delivery (commit) order. Carries routing
 * fields only; consumers re-read authority from current rows, never from the
 * event. Payloads stay in the table. */
export type RealtimeSecurityEvent = Readonly<{
  /** `security_events.delivery_sequence`: global, gap-free per publication. */
  sequence: number;
  kind: SecurityEventWire["kind"];
  userId: string | null;
  organizationId: string | null;
  workspaceId: string | null;
  providerSessionId: string | null;
}>;

export type SecurityEventGapReason =
  /** The LISTEN session (re)connected; notifications may have been lost. */
  | "listener_restored"
  /** More events arrived in one wake than the feed replays. */
  | "overflow";

/** A typed consumer of the realtime security-event feed. `events` receives
 * every published event after the feed's start cursor exactly once and in
 * order, unless `gap` is called first: then the subscriber must re-read the
 * current state of everything it serves, because events in between may never
 * be delivered. Callbacks must not throw and must not block; slow work is
 * scheduled by the subscriber. */
export interface SecurityEventSubscriber {
  events(batch: readonly RealtimeSecurityEvent[]): void;
  gap(reason: SecurityEventGapReason): void;
}

/** One per realtime process. Every device-stream (and, later, other realtime)
 * consumer subscribes here instead of opening its own LISTEN or polling the
 * table. The NOTIFY on `zeros_security_event` is only a wake-up: the feed
 * publishes pending rows, then replays durable rows by delivery sequence.
 * Listener loss is repaired by a `gap` to every subscriber once LISTEN is
 * back, plus a periodic re-read that catches a lost notification. */
export interface RealtimeSecurityEventFeed {
  subscribe(subscriber: SecurityEventSubscriber): () => void;
  /** The highest delivery sequence handed to subscribers. */
  cursor(): number;
  /** False while LISTEN is down; subscribers then rely on the next `gap`. */
  healthy(): boolean;
  /** Requests a read soon (coalesced). */
  wake(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Durable reads behind the feed, injectable for tests. */
export interface SecurityEventSource {
  /** Publishes pending rows (assigns delivery sequences). */
  publish(): Promise<unknown>;
  /** The highest delivery sequence currently visible. */
  head(): Promise<number>;
  /** Published, unexpired events with delivery sequence > `after`, ascending. */
  after(after: number, limit: number): Promise<RealtimeSecurityEvent[]>;
  /** One MVCC observation of the committed publication cut. SKIP LOCKED
   * publication alone cannot prove that every committed row was delivered. */
  watermark?(): Promise<{ cursor: number; pending: boolean }>;
}

export class DatabaseSecurityEventSource implements SecurityEventSource {
  constructor(private readonly pool: pg.Pool) {}

  publish(): Promise<number> { return publishPendingSecurityEvents(this.pool); }

  head(): Promise<number> {
    return withSystemTx(this.pool, async tx => Number((await tx.query<{ cursor: string }>(
      "SELECT COALESCE(max(delivery_sequence), 0) AS cursor FROM security_events")).rows[0]?.cursor ?? 0));
  }

  watermark(): Promise<{ cursor: number; pending: boolean }> {
    return withSystemTx(this.pool, async tx => {
      const row = (await tx.query<{ cursor: string; pending: boolean }>(`SELECT
        COALESCE((SELECT max(delivery_sequence) FROM security_events), 0) AS cursor,
        EXISTS (SELECT 1 FROM security_events
          WHERE delivery_sequence IS NULL AND expires_at > clock_timestamp()) AS pending`)).rows[0]!;
      return { cursor: Number(row.cursor), pending: row.pending };
    });
  }

  after(after: number, limit: number): Promise<RealtimeSecurityEvent[]> {
    return withSystemTx(this.pool, async tx => (await tx.query<{ sequence: string; kind: SecurityEventWire["kind"];
      user_id: string | null; org_id: string | null; workspace_id: string | null; provider_session_id: string | null }>(
      `SELECT delivery_sequence AS sequence, kind, user_id, org_id, workspace_id, provider_session_id
       FROM security_events WHERE delivery_sequence > $1 AND expires_at > now()
       ORDER BY delivery_sequence LIMIT $2`, [after, limit])).rows.map(row => ({
      sequence: Number(row.sequence), kind: row.kind, userId: row.user_id, organizationId: row.org_id,
      workspaceId: row.workspace_id, providerSessionId: row.provider_session_id,
    })));
  }
}

export class DatabaseRealtimeSecurityEventFeed implements RealtimeSecurityEventFeed {
  private readonly subscribers = new Set<SecurityEventSubscriber>();
  private readonly listener: PostgresNotificationSubscription | null;
  private readonly pollMs: number;
  private readonly logger: Pick<Console, "warn">;
  private position = 0;
  private positioned = false;
  private listening = false;
  private everReady = false;
  private running: Promise<void> | null = null;
  private again = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopped = false;
  private failures = 0;
  private readonly lossListeners = new Set<() => void>();

  constructor(private readonly source: SecurityEventSource, options: {
    /** Dedicated LISTEN pool; omitted in tests that drive `wake` directly. */
    listenerPool?: pg.Pool; pollMs?: number; logger?: Pick<Console, "warn">;
  } = {}) {
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.logger = options.logger ?? console;
    this.listener = options.listenerPool ? postgresNotificationSubscription(options.listenerPool, {
      channels: [SECURITY_EVENT_CHANNEL],
      onNotification: () => this.wake(),
      onReady: () => {
        this.listening = true;
        if (this.everReady) this.gapAll("listener_restored");
        this.everReady = true;
        this.wake();
      },
      onDisconnect: () => { this.listening = false; this.lost(); },
    }) : null;
    if (!this.listener) this.listening = true;
  }

  subscribe(subscriber: SecurityEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => { this.subscribers.delete(subscriber); };
  }

  cursor(): number { return this.position; }
  healthy(): boolean { return this.started && !this.stopped && this.listening && this.positioned; }

  onHealthLost(listener: () => void): () => void {
    this.lossListeners.add(listener);
    return () => { this.lossListeners.delete(listener); };
  }
  private lost(): void {
    this.failures += 1;
    for (const listener of [...this.lossListeners]) listener();
  }

  /** Called by the one shared D4 challenge batch, never per turn. Force a
   * read begun after this request, including publication, then prove that
   * no committed unpublished row or unseen delivered row precedes the cut. */
  async observeAuthority(): Promise<boolean> {
    if (!this.healthy() || !this.source.watermark) return false;
    const failures = this.failures;
    await this.settled();
    if (!this.healthy()) return false;
    this.wake();
    await this.settled();
    try {
      const cut = await this.source.watermark();
      if (cut.pending) { this.lost(); return false; }
      if (this.position < cut.cursor) { this.wake(); await this.settled(); }
      return this.healthy() && failures === this.failures && this.position >= cut.cursor;
    } catch { this.lost(); return false; }
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    // Subscribers start from the current head: the device stream reads a
    // fresh snapshot per connection, so earlier events are already folded in.
    while (!this.stopped) {
      try { this.position = await this.source.head(); break; }
      catch { await new Promise(resolve => setTimeout(resolve, READ_RETRY_MS)); }
    }
    if (this.stopped) return;
    this.positioned = true;
    this.poll = setInterval(() => this.wake(), this.pollMs);
    this.poll.unref?.();
    void this.listener?.start().catch(() => this.logger.warn("[realtime] security event listener unavailable; relying on periodic reads"));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.lost();
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    await this.listener?.stop();
    await this.running;
    this.subscribers.clear();
    this.lossListeners.clear();
  }

  wake(): void {
    if (!this.positioned || this.stopped) return;
    if (this.running) { this.again = true; return; }
    this.running = this.drain().finally(() => {
      this.running = null;
      if (this.again && !this.stopped) { this.again = false; this.wake(); }
    });
  }

  /** Resolves once the current and any re-requested read finish. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    try {
      await this.source.publish().catch(() => { this.lost(); });
      for (let page = 0; page < MAX_PAGES_PER_WAKE && !this.stopped; page += 1) {
        const batch = await this.source.after(this.position, PAGE_SIZE);
        if (this.stopped || batch.length === 0) return;
        this.position = batch[batch.length - 1]!.sequence;
        this.deliver(batch);
        if (batch.length < PAGE_SIZE) return;
      }
      if (this.stopped) return;
      this.position = Math.max(this.position, await this.source.head());
      this.gapAll("overflow");
    } catch {
      this.lost();
      // The cursor did not move, so nothing is lost; retry soon.
      if (this.stopped) return;
      const retry = setTimeout(() => this.wake(), READ_RETRY_MS);
      retry.unref?.();
    }
  }

  private deliver(batch: readonly RealtimeSecurityEvent[]): void {
    const frozen = Object.freeze([...batch]);
    for (const subscriber of [...this.subscribers]) {
      try { subscriber.events(frozen); }
      catch { this.logger.warn("[realtime] security event subscriber failed"); }
    }
  }

  private gapAll(reason: SecurityEventGapReason): void {
    this.lost();
    for (const subscriber of [...this.subscribers]) {
      try { subscriber.gap(reason); }
      catch { this.logger.warn("[realtime] security event subscriber failed"); }
    }
  }
}
