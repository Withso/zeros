import type pg from "pg";

import { withSystemStatement } from "../db.js";
import { SqlFragment, sql } from "../sql-fragment.js";
import type { UplinkIdentity } from "./uplink-authority.js";
import { UPLINK_FEATURES } from "./uplink-protocol.js";
import type { UplinkExtension, UplinkSession } from "./uplink-server.js";

/** The negotiated feature for checkpoint-request push (S2 checkpoint channel). */
export const UPLINK_CHECKPOINT_FEATURE = UPLINK_FEATURES.checkpoint;
/** Requests pushed per engine and read; a workspace rarely has more than one queued. */
export const UPLINK_CHECKPOINT_REQUESTS_PER_ENGINE = 8;
const QUEUED_CHUNK = 500;
const TICK_MS = 5_000;
/** Ticks between full re-reads while the LISTEN session counts as current:
 * a connection that died silently is noticed only by TCP keepalive, so a
 * missed notification still reaches its engine within 30 s. */
const SWEEP_TICKS = 6;

export type UplinkCheckpointRequest = Readonly<{ requestId: string; reason: string; deadlineAtMs: number }>;

/** Reads `workspace_checkpoint_requests` (FORCE ROW LEVEL SECURITY with a
 * system policy) through `withSystemStatement`. Read-only: delivery,
 * fencing and acknowledgement stay on the heartbeat. */
export class DatabaseUplinkCheckpointStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Queued, unexpired requests of each identity's exact workspace,
   * organization and generation, oldest first (the heartbeat's delivery
   * order), at most eight per identity, one statement per 500 identities.
   * Identities without one are absent. */
  async queued(identities: readonly UplinkIdentity[]): Promise<Map<string, UplinkCheckpointRequest[]>> {
    const engines = new Map<string, string[]>();
    for (const identity of identities) {
      const key = `${identity.workspaceId}:${identity.organizationId}:${identity.generation}`;
      const ids = engines.get(key) ?? [];
      if (!ids.includes(identity.engineInstanceId)) ids.push(identity.engineInstanceId);
      engines.set(key, ids);
    }
    const keys = [...engines.keys()];
    const queued = new Map<string, UplinkCheckpointRequest[]>();
    for (let start = 0; start < keys.length; start += QUEUED_CHUNK) {
      const tuples = SqlFragment.list(keys.slice(start, start + QUEUED_CHUNK).map(key => {
        const [workspaceId, organizationId, generation] = key.split(":") as [string, string, string];
        return sql`(${SqlFragment.uuid(workspaceId)}, ${SqlFragment.uuid(organizationId)}, ${SqlFragment.integer(Number(generation), 1, 2_147_483_647)})`;
      }));
      const limit = SqlFragment.integer(UPLINK_CHECKPOINT_REQUESTS_PER_ENGINE, 1, 100);
      const result = await withSystemStatement<{
        workspace_id: string; org_id: string; generation: number; id: string; reason: string; deadline_at: Date;
      }>(this.pool, sql`SELECT workspace_id, org_id, generation, id, reason, deadline_at FROM (
          SELECT workspace_id, org_id, generation, id, reason, deadline_at,
            row_number() OVER (PARTITION BY workspace_id, org_id, generation ORDER BY created_at, id) AS position
          FROM workspace_checkpoint_requests
          WHERE state = 'queued' AND deadline_at > now() AND (workspace_id, org_id, generation) IN (${tuples})
        ) queued WHERE position <= ${limit} ORDER BY workspace_id, org_id, generation, position`);
      for (const row of result.rows) {
        const deadlineAtMs = new Date(row.deadline_at).getTime();
        if (!Number.isSafeInteger(deadlineAtMs)) continue;
        for (const engineInstanceId of engines.get(`${row.workspace_id}:${row.org_id}:${Number(row.generation)}`) ?? []) {
          const requests = queued.get(engineInstanceId) ?? [];
          requests.push({ requestId: row.id, reason: row.reason, deadlineAtMs });
          queued.set(engineInstanceId, requests);
        }
      }
    }
    return queued;
  }
}

/** Checkpoint-request push (S2: `checkpoint.request`, replacing the engine's
 * checkpoint-hint long-poll while its uplink is up). The frame is a timing
 * hint only: the engine answers it with one heartbeat, which delivers,
 * fences and acknowledges the directive exactly as before, so a stale,
 * duplicate or foreign frame costs one heartbeat at most.
 *
 * An uplink is read when its gate opens (the contract's resync rule), when
 * a request is queued for its exact workspace and generation, after the
 * notification listener reconnects, on every 5 s tick while the listener is
 * not current, and every 30 s otherwise. Reads are batched and single
 * flight; uplinks whose read failed stay pending for the next tick. */
export class UplinkCheckpointPush implements UplinkExtension {
  readonly feature = UPLINK_CHECKPOINT_FEATURE;
  /** Off, `checkpoint.v1` is never negotiated, so the engine keeps its hint wait. */
  readonly flag = "checkpoint_push" as const;
  private readonly sessions = new Map<string, UplinkSession>();
  private readonly pending = new Set<string>();
  private readonly readQueued: (identities: readonly UplinkIdentity[]) => Promise<ReadonlyMap<string, readonly UplinkCheckpointRequest[]>>;
  private readonly notificationsCurrent: () => boolean;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticksSinceSweep = 0;
  private reading = false;
  private closed = false;

  constructor(options: {
    readQueued: (identities: readonly UplinkIdentity[]) => Promise<ReadonlyMap<string, readonly UplinkCheckpointRequest[]>>;
    /** True while the uplink LISTEN session is current. */
    notificationsCurrent: () => boolean;
    tickMs?: number;
  }) {
    this.readQueued = options.readQueued;
    this.notificationsCurrent = options.notificationsCurrent;
    this.tickMs = options.tickMs ?? TICK_MS;
  }

  /** The gate opened: a fresh lineage and a resume alike get every queued
   * request, since the engine may have missed any of them. */
  onOpen(session: UplinkSession, _resumed: boolean): void {
    if (this.closed) return;
    this.sessions.set(session.identity.engineInstanceId, session);
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.tickMs);
      this.timer.unref?.();
    }
    this.mark([session.identity.engineInstanceId]);
  }

  onClose(session: UplinkSession): void {
    const engineInstanceId = session.identity.engineInstanceId;
    if (this.sessions.get(engineInstanceId) !== session) return;
    this.sessions.delete(engineInstanceId);
    this.pending.delete(engineInstanceId);
    if (!this.sessions.size) this.stopTimer();
  }

  /** A request was queued (or re-enqueued) for this workspace generation.
   * Routed by the authenticated identity only; the payload is a lookup key. */
  requested(workspaceId: string, generation: number): void {
    const ids: string[] = [];
    for (const [engineInstanceId, session] of this.sessions)
      if (session.identity.workspaceId === workspaceId && session.identity.generation === generation) ids.push(engineInstanceId);
    if (ids.length) this.mark(ids);
  }

  /** The notification listener (re)connected: a request queued while it was
   * down never notified, and an engine whose gate is already open never
   * re-gates. */
  async resync(engineInstanceIds: readonly string[]): Promise<void> {
    this.mark(engineInstanceIds);
  }

  close(): void {
    this.closed = true;
    this.stopTimer();
    this.sessions.clear();
    this.pending.clear();
  }

  private tick(): void {
    this.ticksSinceSweep += 1;
    if (!this.notificationsCurrent() || this.ticksSinceSweep >= SWEEP_TICKS) {
      this.ticksSinceSweep = 0;
      for (const engineInstanceId of this.sessions.keys()) this.pending.add(engineInstanceId);
    }
    void this.flush();
  }

  private mark(engineInstanceIds: readonly string[]): void {
    if (this.closed || !engineInstanceIds.length) return;
    for (const engineInstanceId of engineInstanceIds) this.pending.add(engineInstanceId);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.reading || this.closed) return;
    const sessions = [...this.pending].flatMap(id => this.sessions.get(id) ?? []);
    this.pending.clear();
    if (!sessions.length) return;
    this.reading = true;
    let queued: ReadonlyMap<string, readonly UplinkCheckpointRequest[]>;
    try {
      queued = await this.readQueued(sessions.map(session => session.identity));
    } catch {
      // Retried on the next tick, never at once: an unavailable database
      // must not turn into a read loop.
      for (const session of sessions) this.pending.add(session.identity.engineInstanceId);
      this.reading = false;
      return;
    }
    this.reading = false;
    if (this.closed) return;
    for (const session of sessions) {
      if (this.sessions.get(session.identity.engineInstanceId) !== session) continue;
      for (const request of queued.get(session.identity.engineInstanceId) ?? [])
        session.sendReliable("checkpoint.request", { requestId: request.requestId, reason: request.reason, deadlineAtMs: request.deadlineAtMs });
    }
    // Requests notified while the read ran.
    if (this.pending.size) void this.flush();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ticksSinceSweep = 0;
  }
}
