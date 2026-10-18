import type pg from "pg";

import { withSystemTx } from "../db.js";
import { DEVICE_STREAM_TURN_CHANNEL } from "./device-stream-notifications.js";
import type { UplinkIdentity } from "./uplink-authority.js";
import { UPLINK_FEATURES, UplinkTurnEventSchema, type UplinkTurnEvent } from "./uplink-protocol.js";
import type { UplinkExtension, UplinkSession } from "./uplink-server.js";

/** Frames one uplink may have waiting for the store. The engine keeps at most
 * 64 unacked, so only a misbehaving engine reaches it; a dropped frame is
 * repaired by the engine's gap or stall resend. */
const MAX_PENDING = 128;
/** Events one uplink may store at once, then per second. The engine keeps
 * at most 64 unacked and a turn makes two or three transitions, so only a
 * misbehaving engine reaches it; a dropped frame is repaired by the
 * engine's gap or stall resend. */
const BURST = 128;
const REFILL_PER_SECOND = 10;

export type UplinkTurnRecord =
  | { result: "stored" | "duplicate" }
  | { result: "gap"; expectedJournalSeq: number }
  | { result: "unavailable" };

export interface UplinkTurnStore {
  record(identity: UplinkIdentity, event: UplinkTurnEvent): Promise<UplinkTurnRecord>;
}

const NOTIFIED = {
  completed: { kind: "turn.completed", title: "Turn completed" },
  failed: { kind: "turn.failed", title: "Turn failed" },
  needs_attention: { kind: "turn.needs_attention", title: "Turn needs attention" },
} as const;

/** One system transaction: the stream's high-water mark, the insert, and for
 * a first terminal transition of this workspace, chat, turn and state, the
 * device-stream notice. Two uplinks of one boot (a supersede) may race on the
 * same sequence; the unique key makes the loser a duplicate. */
export class DatabaseUplinkTurnStore implements UplinkTurnStore {
  constructor(private readonly pool: pg.Pool) {}

  async record(identity: UplinkIdentity, event: UplinkTurnEvent): Promise<UplinkTurnRecord> {
    try {
      return await withSystemTx(this.pool, async tx => {
        await tx.query("SET LOCAL lock_timeout = '2s'");
        const high = Number((await tx.query<{ high: string }>(
          `SELECT coalesce(max(journal_seq), 0)::text AS high FROM cloud_workspace_turn_events
           WHERE engine_instance_id = $1 AND boot_id = $2`, [identity.engineInstanceId, identity.bootId])).rows[0]!.high);
        if (event.journalSeq <= high) return { result: "duplicate" } as const;
        if (event.journalSeq > high + 1) return { result: "gap", expectedJournalSeq: high + 1 } as const;
        const inserted = await tx.query<{ id: string; created_at: Date }>(
          `INSERT INTO cloud_workspace_turn_events
             (workspace_id, org_id, engine_instance_id, boot_id, journal_seq, chat_id, turn_id, state, at, actor_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9::double precision / 1000), $10)
           ON CONFLICT (engine_instance_id, boot_id, journal_seq) DO NOTHING
           RETURNING id, created_at`,
          [identity.workspaceId, identity.organizationId, identity.engineInstanceId, identity.bootId, event.journalSeq,
            event.chatId, event.turnId, event.state, event.atMs, event.actorUserId ?? null]);
        const row = inserted.rows[0];
        if (!row) return { result: "duplicate" } as const;
        const notified = event.state in NOTIFIED ? NOTIFIED[event.state as keyof typeof NOTIFIED] : null;
        if (notified) {
          const earlier = await tx.query(
            `SELECT 1 FROM cloud_workspace_turn_events
             WHERE workspace_id = $1 AND chat_id = $2 AND turn_id = $3 AND state = $4 AND id <> $5 LIMIT 1`,
            [identity.workspaceId, event.chatId, event.turnId, event.state, row.id]);
          if (!earlier.rowCount) await tx.query("SELECT pg_notify($1, $2)", [DEVICE_STREAM_TURN_CHANNEL, JSON.stringify({
            id: row.id, kind: notified.kind, workspaceId: identity.workspaceId, chatId: event.chatId, turnId: event.turnId,
            title: notified.title, createdAt: row.created_at.toISOString() })]);
        }
        return { result: "stored" } as const;
      });
    } catch {
      return { result: "unavailable" };
    }
  }
}

type Chain = { tail: Promise<void>; pending: number; gapReported: number | null; tokens: number; refilledAtMs: number };

/** `turns.v1`: persists each `turns.event` in receive order and acks it.
 * Routing never reads the payload's IDs: the store is keyed by the uplink's
 * authenticated identity. */
export class UplinkTurnJournal implements UplinkExtension {
  readonly feature = UPLINK_FEATURES.turns;
  readonly flag = "turn_journal" as const;
  private readonly chains = new WeakMap<UplinkSession, Chain>();

  constructor(private readonly options: { store: UplinkTurnStore; logger?: Pick<Console, "warn">; now?: () => number }) {}

  onFrame(session: UplinkSession, t: string, d: Record<string, unknown>): boolean | "invalid" {
    if (t !== "turns.event") return false;
    const parsed = UplinkTurnEventSchema.safeParse(d);
    if (!parsed.success) return "invalid";
    let chain = this.chains.get(session);
    if (!chain) { chain = { tail: Promise.resolve(), pending: 0, gapReported: null, tokens: BURST, refilledAtMs: this.now() }; this.chains.set(session, chain); }
    const now = this.now();
    chain.tokens = Math.min(BURST, chain.tokens + ((now - chain.refilledAtMs) * REFILL_PER_SECOND) / 1000);
    chain.refilledAtMs = now;
    if (chain.pending >= MAX_PENDING || chain.tokens < 1) return true;
    chain.tokens -= 1;
    const current = chain;
    current.pending += 1;
    current.tail = current.tail
      .then(() => this.record(session, current, parsed.data))
      .catch(() => { (this.options.logger ?? console).warn("[realtime] turn journal record failed"); })
      .finally(() => { current.pending -= 1; });
    return true;
  }

  private now(): number { return this.options.now ? this.options.now() : performance.now(); }

  private async record(session: UplinkSession, chain: Chain, event: UplinkTurnEvent): Promise<void> {
    const outcome = await this.options.store.record(session.identity, event);
    if (outcome.result === "stored" || outcome.result === "duplicate") {
      session.sendReliable("turns.ack", { journalSeq: event.journalSeq });
      return;
    }
    if (outcome.result === "gap" && chain.gapReported !== outcome.expectedJournalSeq) {
      chain.gapReported = outcome.expectedJournalSeq;
      session.sendError?.("turn_journal_gap", "turn journal sequence gap", { expectedJournalSeq: outcome.expectedJournalSeq });
    }
  }
}
