// Hello SQL retained from main331e9c6b, before environment readiness exists.
import type pg from "pg";
import { withSystemTx } from "../../db.js";
import { hashCloudV2Token } from "../tokens.js";
import { CLOUD_V2_LIVE_ACCESS as LIVE_ACCESS } from "../workspace-access.js";
const COLUMNS = `id, org_id, creator_user_id, name, repository, branch, base_branch, state, boat_sandbox_id,
  computer_build_id, error_code, active_at, archived_at, created_at, updated_at`;
export async function legacyEnvironmentHello(pool: pg.Pool, token: string, bootId: string) {
  const { rows } = await withSystemTx(pool, tx => tx.query(`WITH prior AS MATERIALIZED (
         SELECT id AS prior_id, state AS prior_state, updated_at AS prior_updated_at FROM cloud_v2_workspaces w
         WHERE worker_token_hash=$1 AND state IN ('creating','starting','running') AND ${LIVE_ACCESS}
           AND ($3::bigint IS NULL OR (worker_boot_id=$2 AND access_epoch=$3 AND login_revision=$4::bigint)) FOR UPDATE)
       UPDATE cloud_v2_workspaces w SET
         worker_history_sequence=CASE WHEN worker_boot_id=$2 THEN worker_history_sequence ELSE 0 END,
         worker_history_digest=CASE WHEN worker_boot_id=$2 THEN worker_history_digest ELSE NULL END,
         worker_boot_id=$2, state='running', attempts=0, next_attempt_at=NULL,
         active_at=CASE WHEN state='running' THEN active_at ELSE clock_timestamp() END,
         updated_at=CASE WHEN state='running' THEN updated_at ELSE clock_timestamp() END
       FROM prior WHERE w.id=prior.prior_id
       RETURNING ${COLUMNS.replace(/\b(\w+)\b/g, "w.$1")}, access_epoch::text, login_revision::text, prior.prior_state,
         greatest(0, extract(epoch FROM (clock_timestamp()-prior.prior_updated_at))*1000)::float8 AS hello_ms`, [hashCloudV2Token(token), bootId, null, null]));
  return rows[0] as { state: string } | undefined;
}
