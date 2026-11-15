import type pg from "pg";
import { withSystemTx } from "../../db.js";
import { hashCloudV2Token } from "../tokens.js";

/** R2 (message-authority-v1). One barrier per control-plane instance replaces every per-context renewal. */
export const AUTHORITY_BARRIER_MS = 5_000;
/** Running work outlives the last fresh barrier by at most this much (owner decision, 2026-11-14). */
export const AUTHORITY_RUNNING_CUTOFF_MS = 600_000;
/** A context is rewritten only when its expiry would fall within this much of the cutoff (≈ one row write a minute). */
const EXTEND_WITHIN_MS = 540_000;
/** Maintenance re-admits at the re-check; contexts outlive it by this much so a timely re-check never expires them. */
export const AUTHORITY_RECHECK_GRACE_MS = 60_000;

export type AuthorityBootState = {
  workspaceId: string; bootId: string; sequence: bigint; acked: bigint;
  /** Wall time of the barrier read this state came from (server clock). */
  observedAt: number;
  /** Proof is fresh: every revocation up to `sequence` is acknowledged and no re-evaluation is due. */
  fresh: boolean;
  /** Server-side context horizon for this boot as of the barrier. */
  until: number;
};
type Row = { workspace_id: string; boot_id: string; worker_token_hash: Buffer; sequence: string; acked: string; recheck_at: Date | null; cutoff: boolean };

const BOOTS = `FROM cloud_v2_execution_boots b
  JOIN cloud_v2_workspaces w ON w.id=b.workspace_id AND w.worker_boot_id=b.boot_id AND w.worker_token_hash=b.worker_token_hash
    AND w.state IN ('creating','starting','running') AND w.execution_mode='active'
  WHERE b.authority_mode='message-authority-v1' AND b.replaced_by IS NULL`;
const SEQUENCE = (boot: string) => `coalesce((SELECT max(e.id) FROM cloud_v2_authority_events e WHERE e.workspace_id=${boot}.workspace_id),0)`;
const RECHECK = (boot: string) => `(SELECT min(r.at) FROM cloud_v2_authority_rechecks r WHERE r.workspace_id=${boot}.workspace_id)`;

/** In-memory freshness for every live R2 boot, refreshed by one transaction per tick. Worker pulls read it without the database. */
export class AuthorityBarrier {
  private readonly boots = new Map<string, AuthorityBootState & { tokenHash: Buffer }>();
  private timer?: ReturnType<typeof setTimeout>;
  private running: Promise<void> | undefined;
  private closed = false;
  constructor(private readonly pool: pg.Pool, private readonly now: () => number = Date.now,
    private readonly logger?: Pick<Console, "warn">) {}

  async tick(): Promise<void> {
    // The proof's age starts before the read: a slow query never makes it look fresher.
    const observedAt = this.now();
    const rows = await withSystemTx(this.pool, async tx => {
      // A pending cut-off (an invalidation maintenance has not applied yet) withholds freshness: its contexts may still be active.
      const state = await tx.query<Row>(`SELECT b.workspace_id,b.boot_id,b.worker_token_hash,${SEQUENCE("b")}::text AS sequence,
        b.authority_acked_sequence::text AS acked,${RECHECK("b")} AS recheck_at,
        EXISTS(SELECT 1 FROM cloud_v2_execution_invalidations i WHERE i.workspace_id=b.workspace_id) AS cutoff ${BOOTS}`);
      // Rows a revoker holds are skipped, never waited on; the next tick takes them.
      await tx.query(`WITH target AS MATERIALIZED (
          SELECT c.id FROM cloud_v2_execution_contexts c
          JOIN cloud_v2_execution_boots b ON b.workspace_id=c.workspace_id AND b.boot_id=c.worker_boot_id
          JOIN cloud_v2_workspaces w ON w.id=b.workspace_id AND w.worker_boot_id=b.boot_id AND w.worker_token_hash=b.worker_token_hash
            AND w.state IN ('creating','starting','running') AND w.execution_mode='active'
          WHERE b.authority_mode='message-authority-v1' AND b.replaced_by IS NULL AND c.state='active'
            AND b.authority_acked_sequence>=${SEQUENCE("b")} AND coalesce(${RECHECK("b")},'infinity')>clock_timestamp()
            AND NOT EXISTS(SELECT 1 FROM cloud_v2_execution_invalidations i WHERE i.workspace_id=b.workspace_id)
            AND c.expires_at<clock_timestamp()+make_interval(secs=>$2::double precision/1000)
          ORDER BY c.id FOR UPDATE OF c SKIP LOCKED)
        UPDATE cloud_v2_execution_contexts c SET expires_at=least(clock_timestamp()+make_interval(secs=>$1::double precision/1000),
          coalesce(${RECHECK("c")},'infinity')
            +make_interval(secs=>$3::double precision/1000))
        WHERE c.id IN (SELECT id FROM target)`, [AUTHORITY_RUNNING_CUTOFF_MS, EXTEND_WITHIN_MS, AUTHORITY_RECHECK_GRACE_MS]);
      return state.rows;
    });
    const next = new Map<string, AuthorityBootState & { tokenHash: Buffer }>();
    for (const row of rows) {
      const key = `${row.worker_token_hash.toString("hex")}:${row.boot_id}`, recheck = row.recheck_at?.getTime() ?? Infinity;
      const fresh = BigInt(row.acked) >= BigInt(row.sequence) && recheck > observedAt && !row.cutoff;
      const previous = this.boots.get(key);
      next.set(key, { workspaceId: row.workspace_id, bootId: row.boot_id, tokenHash: row.worker_token_hash,
        sequence: BigInt(row.sequence), acked: BigInt(row.acked), observedAt: fresh ? observedAt : previous?.observedAt ?? 0, fresh,
        until: fresh ? Math.min(observedAt + AUTHORITY_RUNNING_CUTOFF_MS, recheck + AUTHORITY_RECHECK_GRACE_MS) : previous?.until ?? 0 });
    }
    this.boots.clear();
    for (const [key, value] of next) this.boots.set(key, value);
  }

  /** The boot's state, found only by the worker credential that owns it. */
  lookup(token: string, bootId: string): AuthorityBootState | undefined {
    const entry = this.boots.get(`${hashCloudV2Token(token).toString("hex")}:${bootId.toLowerCase()}`);
    if (!entry) return undefined;
    const { tokenHash: _hash, ...state } = entry;
    return state;
  }

  /** A worker's acknowledgement moves the in-memory copy at once; the database row is written by the caller. */
  acknowledged(token: string, bootId: string, acked: bigint): void {
    const entry = this.boots.get(`${hashCloudV2Token(token).toString("hex")}:${bootId.toLowerCase()}`);
    if (entry && acked > entry.acked) entry.acked = acked;
  }

  start(): void {
    const loop = () => {
      if (this.closed) return;
      this.running = this.tick().catch(error => this.logger?.warn(`[cloud-v2] authority barrier failed (${(error as { code?: string }).code ?? "error"})`))
        .finally(() => { this.running = undefined; if (!this.closed) this.timer = setTimeout(loop, AUTHORITY_BARRIER_MS); });
    };
    loop();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
