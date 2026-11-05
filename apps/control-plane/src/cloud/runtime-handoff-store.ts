import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { HttpError } from "../authz.js";
import { hashCloudV2Token } from "./tokens.js";
import { CLOUD_V2_LIVE_ACCESS } from "./workspace-access.js";
import { CloudEnvironmentReportSchema, type CloudEnvironmentReport } from "./environment-contract.js";

export type RuntimeHandoff = {
  workspace_id: string; id: string; sandbox_id: string; token_hash: Buffer; creator_user_id: string;
  old_boot_id: string; next_boot_id: string; rollback_boot_id: string; instance_id: string;
  prior_rollback_boot_id: string | null; rollback_attempt: number; completed_at: Date | null;
  previous_sha256: string; target_sha256: string; access_epoch: string; login_revision: string;
  stop_generation: string; worker_generation: string;
  state: "prepared" | "committed" | "activating" | "rolling_back" | "succeeded" | "rolled_back" | "cancelled";
  environment_boot_id: string | null; environment_report: CloudEnvironmentReport | null;
  expires_at: Date; updated_at: Date;
};
const unavailable = () => new HttpError(409, "runtime_update_unavailable", "Runtime update is unavailable.");
const sources = `(SELECT coalesce(jsonb_agg(jsonb_build_array(s.repository_id,s.source_repository) ORDER BY s.repository_id,s.source_repository),'[]'::jsonb)
  FROM cloud_v2_github_sources s WHERE s.workspace_id=w.id)`;
const identity = `w.state='running' AND w.archived_at IS NULL AND w.boat_sandbox_id=h.sandbox_id
  AND w.worker_boot_id=h.old_boot_id AND w.worker_token_hash=h.token_hash AND w.org_id=h.org_id
  AND w.creator_user_id=h.creator_user_id AND w.repository=h.repository AND ${sources}=h.source_identity
  AND w.worker_runtime_sha256=h.previous_sha256 AND w.worker_runtime_boot_id=h.old_boot_id
  AND w.stop_generation=h.stop_generation
  AND ${CLOUD_V2_LIVE_ACCESS}`;
const proof = `${identity} AND w.access_epoch=h.access_epoch AND w.login_revision=h.login_revision`;
const active = `('committed','activating','rolling_back')`;

/** The workspace row serializes handoff commitment, relay admission and durable
 * outbox claims. No provider or source lookup runs under that lock. */
export class RuntimeHandoffStore {
  constructor(private readonly pool: pg.Pool) {}

  async recordRuntime(token: string, bootId: string, sha256: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw unavailable();
    await withSystemTx(this.pool, async tx => {
      const changed = await tx.query<{ id: string }>(`UPDATE cloud_v2_workspaces w SET worker_runtime_sha256=$3,
        worker_runtime_unknown_activity=CASE WHEN worker_runtime_boot_id IS DISTINCT FROM $2::uuid THEN false ELSE worker_runtime_unknown_activity END,
        worker_runtime_boot_id=$2 WHERE worker_token_hash=$1 AND worker_boot_id=$2 AND state IN ('starting','running') AND ${CLOUD_V2_LIVE_ACCESS}
        RETURNING id`, [hashCloudV2Token(token), bootId, sha256]);
      if (changed.rows[0]) {
        await tx.query("DELETE FROM cloud_worker_runtime_clients WHERE workspace_id=$1 AND boot_id IS DISTINCT FROM $2::uuid", [changed.rows[0].id, bootId]);
        await tx.query(`UPDATE cloud_worker_runtime_handoffs SET state='cancelled',updated_at=clock_timestamp()
          WHERE workspace_id=$1 AND state IN ('prepared','committed','activating','rolling_back')
          AND (old_boot_id<>$2::uuid OR token_hash<>$3)`, [changed.rows[0].id, bootId, hashCloudV2Token(token)]);
      }
    });
  }

  async runtime(token: string, bootId: string): Promise<string | null> {
    return withSystemTx(this.pool, async tx => (await tx.query<{ worker_runtime_sha256: string | null }>(
      `SELECT worker_runtime_sha256 FROM cloud_v2_workspaces w WHERE worker_token_hash=$1 AND worker_boot_id=$2
       AND worker_runtime_boot_id=$2 AND state='running' AND ${CLOUD_V2_LIVE_ACCESS}`, [hashCloudV2Token(token), bootId])).rows[0]?.worker_runtime_sha256 ?? null);
  }

  async prepare(token: string, bootId: string, input: { target: string; instanceId: string; revision: string; generation: number }): Promise<RuntimeHandoff | null> {
    return withSystemTx(this.pool, async tx => {
      const workspace = (await tx.query<{ id: string }>(`SELECT id FROM cloud_v2_workspaces w WHERE worker_token_hash=$1
        AND worker_boot_id=$2 AND login_revision=$3 AND state='running' AND archived_at IS NULL
        AND boat_sandbox_id IS NOT NULL AND worker_runtime_sha256 IS NOT NULL AND worker_runtime_sha256<>$4
        AND ${CLOUD_V2_LIVE_ACCESS} FOR UPDATE`, [hashCloudV2Token(token), bootId, input.revision, input.target])).rows[0];
      if (!workspace) return null;
      const prior = (await tx.query<RuntimeHandoff>("SELECT * FROM cloud_worker_runtime_handoffs WHERE workspace_id=$1", [workspace.id])).rows[0];
      if (prior && !["cancelled", "succeeded", "rolled_back", "prepared"].includes(prior.state)) return null;
      if (prior && ["succeeded", "rolled_back"].includes(prior.state) && !prior.completed_at) return null;
      if (prior?.state === "prepared" && prior.old_boot_id === bootId.toLowerCase() && prior.target_sha256 === input.target &&
          prior.login_revision === input.revision && Number(prior.worker_generation) === input.generation &&
          prior.instance_id === input.instanceId && await this.current(tx, prior.id, token)) return prior;
      if (prior?.state === "rolled_back" && prior.target_sha256 === input.target &&
          (await tx.query("SELECT 1 FROM cloud_worker_runtime_handoffs WHERE id=$1 AND updated_at>clock_timestamp()-interval '1 hour'", [prior.id])).rowCount) return null;
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      const row = (await tx.query<RuntimeHandoff>(`INSERT INTO cloud_worker_runtime_handoffs
        (workspace_id,id,org_id,creator_user_id,repository,source_identity,sandbox_id,token_hash,old_boot_id,next_boot_id,rollback_boot_id,instance_id,
         previous_sha256,target_sha256,access_epoch,login_revision,stop_generation,worker_generation,state,expires_at)
        SELECT w.id,$2,w.org_id,w.creator_user_id,w.repository,${sources},w.boat_sandbox_id,w.worker_token_hash,w.worker_boot_id,$3,$4,$5,
          w.worker_runtime_sha256,$6,w.access_epoch,w.login_revision,w.stop_generation,$7,'prepared',clock_timestamp()+interval '10 minutes'
        FROM cloud_v2_workspaces w WHERE w.id=$1 AND ${CLOUD_V2_LIVE_ACCESS}
        ON CONFLICT(workspace_id) DO UPDATE SET id=excluded.id,org_id=excluded.org_id,creator_user_id=excluded.creator_user_id,
          repository=excluded.repository,source_identity=excluded.source_identity,sandbox_id=excluded.sandbox_id,token_hash=excluded.token_hash,
          old_boot_id=excluded.old_boot_id,next_boot_id=excluded.next_boot_id,rollback_boot_id=excluded.rollback_boot_id,instance_id=excluded.instance_id,
          previous_sha256=excluded.previous_sha256,target_sha256=excluded.target_sha256,access_epoch=excluded.access_epoch,
          login_revision=excluded.login_revision,stop_generation=excluded.stop_generation,worker_generation=excluded.worker_generation,
          state='prepared',environment_boot_id=NULL,environment_report=NULL,completed_at=NULL,
          rollback_attempt=0,prior_rollback_boot_id=NULL,expires_at=excluded.expires_at,
          created_at=clock_timestamp(),updated_at=clock_timestamp() RETURNING *`,
      [workspace.id, ...ids, input.instanceId, input.target, input.generation])).rows[0];
      return row ?? null;
    });
  }

  async inspect(token: string, id: string): Promise<RuntimeHandoff | null> {
    return withSystemTx(this.pool, async tx => (await tx.query<RuntimeHandoff>(
      "SELECT * FROM cloud_worker_runtime_handoffs WHERE id=$1 AND token_hash=$2", [id, hashCloudV2Token(token)])).rows[0] ?? null);
  }

  private async lock(tx: Tx, id: string): Promise<void> {
    await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=(SELECT workspace_id FROM cloud_worker_runtime_handoffs WHERE id=$1) FOR UPDATE", [id]);
    await tx.query("SELECT id FROM cloud_worker_runtime_handoffs WHERE id=$1 FOR UPDATE", [id]);
  }
  private async current(tx: Tx, id: string, token?: string): Promise<RuntimeHandoff | null> {
    return (await tx.query<RuntimeHandoff>(`SELECT h.* FROM cloud_worker_runtime_handoffs h JOIN cloud_v2_workspaces w ON w.id=h.workspace_id
      WHERE h.id=$1 AND ($2::bytea IS NULL OR h.token_hash=$2) AND h.expires_at>clock_timestamp() AND ${proof}`,
    [id, token ? hashCloudV2Token(token) : null])).rows[0] ?? null;
  }
  async commit(token: string, bootId: string, id: string, revision: string, generation: number, target: string): Promise<boolean> {
    return withSystemTx(this.pool, async tx => {
      await this.lock(tx, id);
      const handoff = await this.current(tx, id, token);
      if (!handoff || handoff.old_boot_id !== bootId.toLowerCase() || handoff.target_sha256 !== target ||
          handoff.login_revision !== revision || Number(handoff.worker_generation) !== generation || !["prepared", "committed"].includes(handoff.state)) return false;
      if (handoff.state === "committed") return true;
      if ((await tx.query(`SELECT 1 FROM cloud_worker_runtime_clients WHERE workspace_id=$1
        UNION ALL SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND worker_runtime_unknown_activity
        UNION ALL SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND state IN ('queued','inboxed','dispatching','accepted')
        UNION ALL SELECT 1 FROM cloud_v2_prompt_chats WHERE workspace_id=$1 AND stop_acked_epoch<epoch LIMIT 1`, [handoff.workspace_id])).rowCount) return false;
      await tx.query("UPDATE cloud_worker_runtime_handoffs SET state='committed',updated_at=clock_timestamp() WHERE id=$1", [id]);
      return true;
    });
  }

  async activate(token: string, id: string): Promise<RuntimeHandoff | null> {
    return withSystemTx(this.pool, async tx => {
      await this.lock(tx, id);
      const handoff = await this.current(tx, id, token);
      if (!handoff || !["committed", "activating"].includes(handoff.state)) return null;
      if (handoff.state === "activating") return null;
      return (await tx.query<RuntimeHandoff>("UPDATE cloud_worker_runtime_handoffs SET state='activating',updated_at=clock_timestamp() WHERE id=$1 RETURNING *", [id])).rows[0]!;
    });
  }

  async cancel(token: string, id: string, bootId: string): Promise<boolean> {
    return withSystemTx(this.pool, async tx => {
      await this.lock(tx, id);
      return Boolean((await tx.query(`UPDATE cloud_worker_runtime_handoffs SET state='cancelled',updated_at=clock_timestamp()
        WHERE id=$1 AND token_hash=$2 AND old_boot_id=$3 AND state IN ('prepared','committed','cancelled')`, [id, hashCloudV2Token(token), bootId])).rowCount);
    });
  }

  async settleUnstarted(id: string): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      await this.lock(tx, id);
      await tx.query("UPDATE cloud_worker_runtime_handoffs SET state='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND state IN ('prepared','committed','activating')", [id]);
    });
  }

  async expireUnactivated(id: string): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      await this.lock(tx, id);
      if (await this.current(tx, id)) return;
      await tx.query("UPDATE cloud_worker_runtime_handoffs SET state='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND state IN ('prepared','committed')", [id]);
    });
  }

  async privateBoot(token: string, id: string, bootId: string, sha256?: string): Promise<RuntimeHandoff | null> {
    return withSystemTx(this.pool, async tx => {
      const handoff = await this.current(tx, id, token);
      if (!handoff) return null;
      const rollback = handoff.state === "rolling_back";
      if (!rollback && handoff.state !== "activating") return null;
      return bootId.toLowerCase() === (rollback ? handoff.rollback_boot_id : handoff.next_boot_id) &&
        (!sha256 || sha256 === (rollback ? handoff.previous_sha256 : handoff.target_sha256)) ? handoff : null;
    });
  }

  async environment(token: string, id: string, bootId: string, raw: CloudEnvironmentReport): Promise<void> {
    const report = CloudEnvironmentReportSchema.parse(raw), boot = bootId.toLowerCase();
    await withSystemTx(this.pool, async tx => {
      await this.lock(tx, id);
      const handoff = await this.current(tx, id, token);
      if (!handoff || !["activating", "rolling_back"].includes(handoff.state) ||
          boot !== (handoff.state === "rolling_back" ? handoff.rollback_boot_id : handoff.next_boot_id)) throw unavailable();
      const pin = (await tx.query<{ version_id: string }>("SELECT version_id FROM cloud_workspace_environment_pins WHERE workspace_id=$1", [handoff.workspace_id])).rows[0];
      if (!pin || pin.version_id !== report.versionId) throw unavailable();
      const previous = handoff.environment_boot_id === boot ? handoff.environment_report : null;
      if (previous && previous.versionId === report.versionId && previous.sequence === report.sequence &&
          previous.state === report.state && previous.errorCode === report.errorCode) return;
      if (previous && (previous.sequence >= report.sequence || previous.state === "ready")) throw unavailable();
      await tx.query("UPDATE cloud_worker_runtime_handoffs SET environment_boot_id=$2,environment_report=$3 WHERE id=$1", [id, boot, JSON.stringify(report)]);
    });
  }

  async promote(token: string, id: string, bootId: string): Promise<boolean> {
    const boot = bootId.toLowerCase();
    return withSystemTx(this.pool, async tx => {
      await this.lock(tx, id);
      const handoff = await this.current(tx, id, token);
      if (!handoff) {
        return Boolean((await tx.query(`SELECT 1 FROM cloud_worker_runtime_handoffs h JOIN cloud_v2_workspaces w ON w.id=h.workspace_id
          WHERE h.id=$1 AND h.token_hash=$2 AND w.worker_token_hash=h.token_hash AND w.worker_boot_id=$3
          AND ((h.state='succeeded' AND h.next_boot_id=$3) OR (h.state='rolled_back' AND h.rollback_boot_id=$3))
          AND w.state='running' AND ${CLOUD_V2_LIVE_ACCESS}`, [id, hashCloudV2Token(token), boot])).rowCount);
      }
      const rollback = handoff.state === "rolling_back";
      if ((!rollback && handoff.state !== "activating") || boot !== (rollback ? handoff.rollback_boot_id : handoff.next_boot_id)) return false;
      const pin = (await tx.query<{ version_id: string }>("SELECT version_id FROM cloud_workspace_environment_pins WHERE workspace_id=$1 FOR UPDATE", [handoff.workspace_id])).rows[0];
      // The seed lock may outlive admission; the database clock owns expiry.
      if (!await this.current(tx, id, token)) return false;
      if (pin) {
        const report = handoff.environment_report;
        if (handoff.environment_boot_id !== boot || report?.state !== "ready" || report.versionId !== pin.version_id) return false;
        await tx.query(`UPDATE cloud_workspace_environment_pins SET ready_boot_id=$2,report_boot_id=$2,report_sequence=$3,
          report_state='ready',report_error=NULL WHERE workspace_id=$1`, [handoff.workspace_id, boot, report.sequence]);
      }
      await tx.query("UPDATE cloud_worker_runtime_handoffs SET state=$2,updated_at=clock_timestamp() WHERE id=$1", [id, rollback ? "rolled_back" : "succeeded"]);
      await tx.query(`UPDATE cloud_v2_workspaces SET worker_boot_id=$2,worker_runtime_boot_id=$2,worker_runtime_sha256=$3,worker_history_sequence=0,worker_history_digest=NULL WHERE id=$1`,
        [handoff.workspace_id, boot, rollback ? handoff.previous_sha256 : handoff.target_sha256]);
      return true;
    });
  }

  async rollback(id: string, authority?: { accessEpoch: string; loginRevision: string }): Promise<RuntimeHandoff | null> {
    return withSystemTx(this.pool, async tx => {
      await this.lock(tx, id);
      const handoff = (await tx.query<RuntimeHandoff>(`SELECT h.* FROM cloud_worker_runtime_handoffs h JOIN cloud_v2_workspaces w ON w.id=h.workspace_id
        WHERE h.id=$1 AND ${identity} AND w.access_epoch=coalesce($2::bigint,h.access_epoch) AND w.login_revision=coalesce($3::bigint,h.login_revision)`,
      [id, authority?.accessEpoch ?? null, authority?.loginRevision ?? null])).rows[0];
      if (!handoff || !["activating", "rolling_back"].includes(handoff.state) || handoff.rollback_attempt >= 3) return null;
      const retry = handoff.state === "rolling_back";
      if (retry && !(await tx.query(`SELECT 1 FROM cloud_worker_runtime_handoffs WHERE id=$1
        AND (environment_report->>'state'='failed' OR updated_at<clock_timestamp()-interval '25 seconds')`, [id])).rowCount) return null;
      return (await tx.query<RuntimeHandoff>(`UPDATE cloud_worker_runtime_handoffs SET state='rolling_back',environment_boot_id=NULL,
        access_epoch=coalesce($2::bigint,access_epoch),login_revision=coalesce($3::bigint,login_revision),
        prior_rollback_boot_id=CASE WHEN $4::uuid IS NULL THEN NULL ELSE rollback_boot_id END,
        rollback_boot_id=coalesce($4::uuid,rollback_boot_id),rollback_attempt=rollback_attempt+1,
        environment_report=NULL,expires_at=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
      [id, authority?.accessEpoch ?? null, authority?.loginRevision ?? null, retry ? randomUUID() : null])).rows[0]!;
    });
  }

  async admitClient(workspaceId: string, clientId: string): Promise<boolean> {
    return withSystemTx(this.pool, async tx => {
      const live = await tx.query(`SELECT id FROM cloud_v2_workspaces w WHERE id=$1 AND ${CLOUD_V2_LIVE_ACCESS} FOR UPDATE`, [workspaceId]);
      if (!live.rowCount) throw unavailable();
      if ((await tx.query(`SELECT 1 FROM cloud_worker_runtime_handoffs WHERE workspace_id=$1 AND state IN ${active}`, [workspaceId])).rowCount) return false;
      const expired = await tx.query("DELETE FROM cloud_worker_runtime_clients WHERE workspace_id=$1 AND expires_at<=clock_timestamp()", [workspaceId]);
      if (expired.rowCount) await tx.query("UPDATE cloud_v2_workspaces SET worker_runtime_unknown_activity=true WHERE id=$1", [workspaceId]);
      const count = (await tx.query<{ count: number }>("SELECT count(*)::int FROM cloud_worker_runtime_clients WHERE workspace_id=$1", [workspaceId])).rows[0]!.count;
      if (count >= 64) throw unavailable();
      await tx.query(`INSERT INTO cloud_worker_runtime_clients(workspace_id,client_id,boot_id,expires_at)
        SELECT id,$2,worker_boot_id,clock_timestamp()+interval '90 seconds' FROM cloud_v2_workspaces WHERE id=$1
        ON CONFLICT(workspace_id,client_id) DO UPDATE SET expires_at=excluded.expires_at`, [workspaceId, clientId]);
      return true;
    });
  }
  async releaseClient(workspaceId: string, clientId: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query("DELETE FROM cloud_worker_runtime_clients WHERE workspace_id=$1 AND client_id=$2", [workspaceId, clientId]));
  }
  async renewClient(workspaceId: string, clientId: string): Promise<boolean> {
    return withSystemTx(this.pool, async tx => Boolean((await tx.query(`UPDATE cloud_worker_runtime_clients SET expires_at=clock_timestamp()+interval '90 seconds'
      WHERE workspace_id=$1 AND client_id=$2 AND expires_at>clock_timestamp()`, [workspaceId, clientId])).rowCount));
  }
  async blocked(workspaceId: string): Promise<boolean> {
    return withSystemTx(this.pool, async tx => Boolean((await tx.query(`SELECT 1 FROM cloud_worker_runtime_handoffs WHERE workspace_id=$1 AND state IN ${active}`, [workspaceId])).rowCount));
  }
  async route(workspaceId: string): Promise<{ blocked: boolean; stopBootIds?: string[] }> {
    return withSystemTx(this.pool, async tx => {
      const h = (await tx.query<RuntimeHandoff>(`SELECT h.* FROM cloud_worker_runtime_handoffs h JOIN cloud_v2_workspaces w ON w.id=h.workspace_id
        WHERE h.workspace_id=$1 AND h.state IN ${active} AND w.worker_token_hash=h.token_hash AND w.boat_sandbox_id=h.sandbox_id`, [workspaceId])).rows[0];
      return h ? { blocked: true, stopBootIds: h.state === "rolling_back" ? [h.rollback_boot_id, h.next_boot_id, h.old_boot_id]
        : h.state === "activating" ? [h.next_boot_id, h.old_boot_id] : [h.old_boot_id] } : { blocked: false };
    });
  }
  async get(id: string): Promise<RuntimeHandoff | null> {
    return withSystemTx(this.pool, async tx => (await tx.query<RuntimeHandoff>("SELECT * FROM cloud_worker_runtime_handoffs WHERE id=$1", [id])).rows[0] ?? null);
  }
  async complete(id: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query("UPDATE cloud_worker_runtime_handoffs SET completed_at=clock_timestamp() WHERE id=$1 AND state IN ('succeeded','rolled_back')", [id]));
  }
  async pending(): Promise<RuntimeHandoff[]> {
    return withSystemTx(this.pool, async tx => (await tx.query<RuntimeHandoff>(`SELECT h.* FROM cloud_worker_runtime_handoffs h
      WHERE h.state IN ('activating','rolling_back') OR (h.state IN ('succeeded','rolled_back') AND h.completed_at IS NULL)
        OR (h.state IN ('prepared','committed') AND (h.expires_at<=clock_timestamp()
        OR NOT EXISTS (SELECT 1 FROM cloud_v2_workspaces w WHERE w.id=h.workspace_id AND ${proof}))) ORDER BY h.updated_at LIMIT 32`)).rows);
  }
}
