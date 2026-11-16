import type pg from "pg";
import { withSystemTx } from "../../db.js";
import { hashCloudV2Token } from "../tokens.js";
import type { CloudV2AuthorityReply, CloudV2ContextReason } from "../contract.js";
import type { AuthorityBarrier } from "./authority-barrier.js";

/** R2 worker pull. Freshness comes from the barrier's memory; the database is touched only while an authority change is
 * unacknowledged (one read of the boot's ended contexts, one write of its acknowledgement). */
export class AuthorityPull {
  constructor(private readonly pool: pg.Pool, readonly barrier: AuthorityBarrier, private readonly now: () => number = Date.now) {}

  async reply(token: string, bootId: string, input: { acked: string; contextIds: readonly string[]; check?: true | undefined }): Promise<CloudV2AuthorityReply | null> {
    const state = this.barrier.lookup(token, bootId);
    if (!state) return null;
    const acked = BigInt(input.acked);
    if (acked > state.acked && acked <= state.sequence && await this.acknowledge(token, bootId, acked))
      this.barrier.acknowledged(token, bootId, acked);
    // The boot's stored acknowledgement counts too (a new boot starts acknowledged; a worker may not know that yet).
    const pending = (acked > state.acked ? acked : state.acked) < state.sequence;
    const ended = (pending || input.check) && input.contextIds.length ? await this.ended(token, bootId, input.contextIds) : [];
    const now = this.now();
    return { sequence: state.sequence.toString(), fresh: state.fresh && !pending, ageMs: Math.max(0, now - state.observedAt),
      untilMs: Math.max(-86_400_000, Math.min(86_400_000, state.until - now)), ended };
  }

  private async acknowledge(token: string, bootId: string, acked: bigint): Promise<boolean> {
    const result = await withSystemTx(this.pool, tx => tx.query(`UPDATE cloud_v2_execution_boots b SET authority_acked_sequence=$3::bigint
      FROM cloud_v2_workspaces w WHERE w.id=b.workspace_id AND w.worker_token_hash=$1 AND w.worker_boot_id=$2::uuid AND b.boot_id=$2::uuid
        AND b.authority_mode='message-authority-v1' AND b.replaced_by IS NULL AND $3::bigint>b.authority_acked_sequence
        AND $3::bigint<=coalesce((SELECT max(e.id) FROM cloud_v2_authority_events e WHERE e.workspace_id=b.workspace_id),0)`,
    [hashCloudV2Token(token), bootId, acked.toString()]));
    return result.rowCount === 1;
  }

  private async ended(token: string, bootId: string, ids: readonly string[]): Promise<Array<{ contextId: string; reason: CloudV2ContextReason }>> {
    const rows = (await withSystemTx(this.pool, tx => tx.query<{ id: string; state: string; reason: CloudV2ContextReason | null; worker_boot_id: string }>(
      `SELECT c.id,c.state,c.reason,c.worker_boot_id FROM cloud_v2_execution_contexts c JOIN cloud_v2_workspaces w ON w.id=c.workspace_id
       WHERE w.worker_token_hash=$1 AND w.worker_boot_id=$2::uuid AND c.id=ANY($3::uuid[])`, [hashCloudV2Token(token), bootId, ids]))).rows;
    const found = new Map(rows.map(row => [row.id, row]));
    return ids.flatMap(id => {
      const row = found.get(id);
      if (!row) return [{ contextId: id, reason: "worker_changed" as const }];
      if (row.worker_boot_id !== bootId.toLowerCase()) return [{ contextId: id, reason: "worker_changed" as const }];
      return row.state === "active" ? [] : [{ contextId: id, reason: row.reason ?? "access_revoked" }];
    });
  }
}
