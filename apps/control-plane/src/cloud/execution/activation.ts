import type pg from "pg";
import { withSystemTx, type Tx } from "../../db.js";
import { HttpError } from "../../authz.js";
import { preparedExecutionSnapshot, type PreparedExecutionSnapshot } from "./activation-snapshot.js";
import type { CloudV2Runtime } from "../runtime.js";
import { notifyCloudV2WorkerReady } from "../worker-ready.js";
import { CLOUD_RECOVERY_TURN_HOLD } from "../recovery-state.js";
import type { CloudExecutionContexts, ExecutionWorkspace } from "./store.js";
import { executionIntentAuthority } from "./authority.js";
import { actorChanged } from "./errors.js";
import { failExecutionActivation } from "./activation-state.js";

type Activation = { id: string; workspace_id: string; phase: string; initiator_user_id: string | null; intent_id: string;
  runtime_sha256: string; access_epoch: string; stop_generation: string; sandbox_id: string | null; boot_id: string | null;
  worker_token_hash: Buffer | null; deadline_at: Date; drained_at: Date | null; prepared_snapshot: PreparedExecutionSnapshot };
const permissionKeys = ["workspaceId","organizationId","creatorUserId","initiatorUserId","sourceRevision","initiatorAccountRevision",
  "initiatorMemberRevision","initiatorMemberCreatedAt","organizationRevision","initiatorConnectionRevision"] as const;
const unchanged = (a: PreparedExecutionSnapshot, b: PreparedExecutionSnapshot) => permissionKeys.every(key => a[key] === b[key]);

/** Lifecycle replicas resume the persisted transition. Provider calls belong
 * to the existing Stop/start engine, never the operator's database transaction. */
export class CloudExecutionActivations {
  constructor(readonly pool: pg.Pool, readonly contexts: CloudExecutionContexts) {}

  async tick() {
    const due = await withSystemTx(this.pool, tx => tx.query<{ id: string }>(`SELECT id FROM cloud_v2_execution_activations
      WHERE phase IN ('draining','authorizing','booting') AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,id LIMIT 8`));
    for (const { id } of due.rows) await this.step(id);
  }

  async step(id: string) {
    const pending = await withSystemTx(this.pool, async tx => {
      const workspace = (await tx.query(`SELECT w.* FROM cloud_v2_workspaces w JOIN cloud_v2_execution_activations a ON a.workspace_id=w.id
        WHERE a.id=$1 FOR UPDATE OF w SKIP LOCKED`, [id])).rows[0];
      if (!workspace) return null;
      const a = (await tx.query<Activation>("SELECT * FROM cloud_v2_execution_activations WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!a || !["draining","authorizing","booting"].includes(a.phase) || workspace.execution_transition_id !== id) return null;
      if (a.deadline_at.getTime() <= Date.now()) { await failExecutionActivation(tx, workspace.id, "activation_timeout"); return null; }
      if (a.phase === "booting" && workspace.state === "failed") {
        await failExecutionActivation(tx, workspace.id, "activation_boot_failed"); return null;
      }
      if (workspace.archived_at || ["deleting","deleted"].includes(workspace.state) || workspace.access_epoch !== a.access_epoch || workspace.stop_generation !== a.stop_generation) {
        await failExecutionActivation(tx, workspace.id, "activation_cancelled"); return null;
      }
      await tx.query("UPDATE cloud_v2_execution_activations SET next_attempt_at=clock_timestamp()+interval '10 seconds' WHERE id=$1", [id]);
      if (a.phase === "draining") {
        if (workspace.state !== "stopping") await failExecutionActivation(tx, workspace.id, "activation_cancelled");
        return null;
      }
      if (a.phase === "booting") {
        if (!["starting","running"].includes(workspace.state) || workspace.restore_pending || !workspace.boat_sandbox_id) {
          await failExecutionActivation(tx, workspace.id, "activation_boot_failed"); return null;
        }
        try {
          if (!a.initiator_user_id) throw actorChanged();
          await this.contexts.deps.authority.cached(tx, workspace.id, a.initiator_user_id);
          if (!unchanged(a.prepared_snapshot, await preparedExecutionSnapshot(tx, workspace.id, a.initiator_user_id))) throw actorChanged();
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          if (error instanceof HttpError && error.status >= 500) return null;
          await failExecutionActivation(tx, workspace.id,
            error instanceof HttpError && error.code === "member_access_revoked" ? "member_access_revoked" : "actor_changed");
        }
        return null;
      }
      if (!a.drained_at || workspace.state !== "stopped" || workspace.worker_token_hash || !a.initiator_user_id) {
        await failExecutionActivation(tx, workspace.id, "actor_changed"); return null;
      }
      let snapshot: PreparedExecutionSnapshot;
      try { snapshot = await preparedExecutionSnapshot(tx, workspace.id, a.initiator_user_id); }
      catch (error) {
        if (!(error instanceof HttpError) || error.status >= 500) throw error;
        await failExecutionActivation(tx, workspace.id, "member_access_revoked"); return null;
      }
      if (!unchanged(a.prepared_snapshot, snapshot)) { await failExecutionActivation(tx, workspace.id, "actor_changed"); return null; }
      await tx.query(`UPDATE cloud_v2_workspaces SET execution_mode='active',execution_initiator_user_id=$2,execution_intent_id=$3
        WHERE id=$1`, [workspace.id,a.initiator_user_id,a.intent_id]);
      return a;
    });
    if (!pending) return;
    try {
      const proof = await this.contexts.deps.authority.admit(pending.workspace_id, pending.initiator_user_id!);
      await withSystemTx(this.pool, async tx => {
        await tx.query("SELECT id FROM users WHERE id=$1 FOR KEY SHARE", [pending.initiator_user_id]);
        const workspace = (await tx.query("SELECT * FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [pending.workspace_id])).rows[0];
        const current = (await tx.query<Activation>("SELECT * FROM cloud_v2_execution_activations WHERE id=$1 FOR UPDATE", [id])).rows[0];
        if (!workspace || !current || current.phase !== "authorizing" || workspace.execution_transition_id !== id) return;
        if (current.deadline_at.getTime() <= Date.now()) { await failExecutionActivation(tx, workspace.id, "activation_timeout"); return; }
        await this.contexts.deps.authority.assert(proof, tx);
        if (workspace.state !== "stopped" || workspace.archived_at || workspace.access_epoch !== pending.access_epoch ||
          workspace.stop_generation !== pending.stop_generation || workspace.execution_intent_id !== pending.intent_id ||
          !unchanged(pending.prepared_snapshot, await preparedExecutionSnapshot(tx, workspace.id, pending.initiator_user_id!))) throw actorChanged();
        await tx.query(`UPDATE cloud_v2_workspaces SET state='starting',execution_intent_authority=$2,worker_token_hash=NULL,worker_boot_id=NULL,
          acting_user_boot_ids='{}',attempts=0,next_attempt_at=NULL,error_code=NULL,updated_at=clock_timestamp() WHERE id=$1`,
        [workspace.id,executionIntentAuthority(proof)]);
        await tx.query("UPDATE cloud_v2_execution_activations SET phase='booting',next_attempt_at=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp() WHERE id=$1", [id]);
      });
    } catch (error) {
      if (error instanceof HttpError && error.status >= 500) return;
      if (!(error instanceof HttpError)) throw error;
      await withSystemTx(this.pool, async tx => {
        if (!(await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 AND execution_transition_id=$2 FOR UPDATE", [pending.workspace_id, id])).rowCount) return;
        await failExecutionActivation(tx, pending.workspace_id, error.code === "member_access_revoked" ? "member_access_revoked" : "actor_changed");
      });
    }
  }
}

export async function executionActivationRuntime(pool: pg.Pool, id: string, runtime: CloudV2Runtime): Promise<CloudV2Runtime | null> {
  const row = (await withSystemTx(pool, tx => tx.query<{ runtime_sha256: string }>(`SELECT a.runtime_sha256
    FROM cloud_v2_workspaces w JOIN cloud_v2_execution_activations a ON a.id=w.execution_transition_id
    WHERE w.id=$1 AND a.phase='booting'`, [id]))).rows[0];
  return row ? { sha256: row.runtime_sha256, url: () => runtime.url(row.runtime_sha256) } : null;
}

export async function bindExecutionActivationBoot(tx: Tx, workspace: ExecutionWorkspace, runtimeSha256: string | undefined) {
  const a = (await tx.query<Activation>(`SELECT a.* FROM cloud_v2_execution_activations a JOIN cloud_v2_workspaces w ON w.execution_transition_id=a.id
    WHERE w.id=$1 FOR UPDATE OF a`, [workspace.id])).rows[0];
  if (!a) return;
  if (a.phase !== "booting" || !a.drained_at || a.deadline_at.getTime() <= Date.now() || a.runtime_sha256 !== runtimeSha256 ||
    a.access_epoch !== workspace.access_epoch || a.stop_generation !== workspace.stop_generation || a.intent_id !== workspace.execution_intent_id ||
    a.initiator_user_id !== workspace.execution_initiator_user_id || a.prepared_snapshot.bootId === workspace.worker_boot_id) throw actorChanged();
  await tx.query("UPDATE cloud_v2_execution_activations SET boot_id=$2,worker_token_hash=$3,updated_at=clock_timestamp() WHERE id=$1",
    [a.id,workspace.worker_boot_id,workspace.worker_token_hash]);
}

export async function completeExecutionActivation(tx: Tx, workspace: ExecutionWorkspace, legacyMaterial: "none" | "removed", contexts: CloudExecutionContexts) {
  const a = (await tx.query<Activation>(`SELECT a.* FROM cloud_v2_execution_activations a JOIN cloud_v2_workspaces w ON w.execution_transition_id=a.id
    WHERE w.id=$1 FOR UPDATE OF a`, [workspace.id])).rows[0];
  if (a) {
    if (a.phase !== "booting" || !a.drained_at || a.deadline_at.getTime() <= Date.now() || a.boot_id !== workspace.worker_boot_id ||
      a.access_epoch !== workspace.access_epoch || a.stop_generation !== workspace.stop_generation || a.intent_id !== workspace.execution_intent_id ||
      !a.worker_token_hash?.equals(workspace.worker_token_hash) || !a.initiator_user_id) throw actorChanged();
    await contexts.deps.authority.cached(tx, workspace.id, a.initiator_user_id);
    if (!unchanged(a.prepared_snapshot, await preparedExecutionSnapshot(tx, workspace.id, a.initiator_user_id))) throw actorChanged();
    await tx.query(`UPDATE cloud_v2_execution_activations SET phase='active',legacy_material=$2,completed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1`, [a.id,legacyMaterial]);
    await tx.query("UPDATE cloud_v2_workspaces SET execution_transition_id=NULL WHERE id=$1", [workspace.id]);
  }
  const ready = await tx.query(`UPDATE cloud_v2_workspaces w SET state='running',attempts=0,next_attempt_at=NULL,active_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=$1 AND state IN ('creating','starting') AND worker_boot_id=$2 AND worker_token_hash=$3 AND access_epoch=$4 AND stop_generation=$5
      AND archived_at IS NULL AND NOT (${CLOUD_RECOVERY_TURN_HOLD}) RETURNING id`, [workspace.id,workspace.worker_boot_id,workspace.worker_token_hash,workspace.access_epoch,workspace.stop_generation]);
  if (ready.rowCount) await notifyCloudV2WorkerReady(tx, workspace.id);
}
