import { randomUUID } from "node:crypto";
import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { CLOUD_V2_LIVE_ACCESS } from "./workspace-access.js";
import { hashCloudV2Token } from "./tokens.js";
import type { ExecutionIntentAuthority } from "./execution/authority.js";
import { cloudV2LifecycleWorkspaceFromRow, cloudV2WorkspaceImage, type CloudV2LifecycleWorkspace, type CloudV2RestoreCreate } from "./store.js";
import { originalSetupBuild } from "./setup-selection.js";
import type { WorkerRoute } from "./worker-connection.js";
import type { CloudRecoveryReply, CloudRecoveryRequest } from "./recovery-quiesce-contract.js";
import type { CloudV2SetupStatus } from "./setup-status-contract.js";
import { notifyCloudV2WorkerReady } from "./worker-ready.js";

export const RECOVERY_CHANNEL = "zeros_cloud_v2_recovery";
export const RECOVERY_WAIT_MS = 10 * 60_000;
export const RECOVERY_DEADLINE_MS = 40 * 60_000;
export const RECOVERY_COOLDOWN_MS = 60 * 60_000;
export const RECOVERY_RETENTION_MS = 24 * 60 * 60_000;
export type RecoveryPhase = "waiting" | "sealing" | "sealed" | "capturing" | "restoring" | "booting" | "verifying" | "succeeded" | "failed" | "cancelled";
export type RecoveryCreate = CloudV2RestoreCreate & { computerBuildId: string; setupBuildId: string | null; setupLegacy?: true;
  createIssuedAt?: string; createRejectedAt?: string; restoreClaimedAt?: string; bootDeliveredAt?: string;
  priorCheckpointObject?: string };
export type RecoveryAttempt = {
  id: string; workspace_id: string; org_id: string; phase: RecoveryPhase;
  source_sandbox_id: string; source_boot_id: string; source_token_hash: Buffer; source_runtime_sha256: string;
  source_route_url: string; source_port_token: unknown; access_epoch: string; stop_generation: string;
  initiator_user_id: string; execution_intent_id: string; authority: ExecutionIntentAuthority;
  worker_generation: string | null; sealed_at: Date | null; source_stopped_at: Date | null;
  checkpoint_object: string | null; checkpoint_key: unknown; checkpoint_sha256: string | null; checkpoint_bytes: string | null;
  checkpoint_upload_until: Date | null; checkpoint_saved_at: Date | null;
  replacement_create: RecoveryCreate | null; replacement_sandbox_id: string | null; replacement_token_hash: Buffer | null;
  replacement_token: unknown; replacement_runtime_sha256: string | null; replacement_boot_id: string | null;
  replacement_route_url: string | null; replacement_port_token: unknown;
  disk_verified_at: Date | null; worker_ready_at: Date | null; setup_succeeded_at: Date | null; published_at: Date | null;
  source_deleted_at: Date | null; replacement_deleted_at: Date | null; first_error_code: string | null;
  lease_id: string | null; lease_until: Date | null; next_attempt_at: Date; deadline_at: Date; completed_at: Date | null;
  created_at: Date; updated_at: Date;
};
type WorkspaceRow = Parameters<typeof cloudV2LifecycleWorkspaceFromRow>[0] & { recovery_attempt_id: string | null; source_repositories: string[] };
const ACTIVE = "('waiting','sealing','sealed','capturing','restoring','booting','verifying')";
const changed = () => new HttpError(409, "recovery_binding_changed", "Workspace recovery changed.");
const BINDING = `w.recovery_attempt_id=a.id AND w.id=a.workspace_id AND w.org_id=a.org_id
  AND w.access_epoch=a.access_epoch AND w.stop_generation=a.stop_generation
  AND w.execution_mode='active' AND w.execution_transition_id IS NULL
  AND w.execution_intent_id=a.execution_intent_id AND w.execution_initiator_user_id=a.initiator_user_id
  AND w.execution_intent_authority=a.authority AND w.archived_at IS NULL AND w.state IN ('running','starting')
  AND ((a.published_at IS NULL AND w.boat_sandbox_id=a.source_sandbox_id AND w.worker_boot_id=a.source_boot_id AND w.worker_token_hash=a.source_token_hash)
    OR (a.published_at IS NOT NULL AND w.boat_sandbox_id=a.replacement_sandbox_id AND w.worker_token_hash=a.replacement_token_hash
      AND (w.worker_boot_id IS NULL OR w.worker_boot_id=a.replacement_boot_id)))
  AND ${CLOUD_V2_LIVE_ACCESS}`;

/** The workspace lock orders recovery against enqueue, dispatch, Stop and
 * revocation. Provider calls never run in a transaction. */
export class CloudRecoveryStore {
  constructor(readonly pool: pg.Pool) {}

  async begin(route: WorkerRoute): Promise<RecoveryAttempt | null> {
    if (!route.bootId || !route.workerTokenHash || !route.url || !route.portToken) return null;
    return withSystemTx(this.pool, async tx => {
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [route.workspace.id]);
      const row = (await tx.query<{ recovery_attempt_id: string | null }>(`SELECT recovery_attempt_id FROM cloud_v2_workspaces w
        WHERE id=$1 AND boat_sandbox_id=$2 AND worker_boot_id=$3 AND worker_token_hash=decode($4,'hex')
          AND worker_route_url=$5 AND worker_port_token=$6::jsonb AND access_epoch=$7
          AND worker_recovery_boot_id=worker_boot_id AND worker_runtime_boot_id=worker_boot_id AND worker_runtime_sha256 IS NOT NULL
          AND state='running' AND archived_at IS NULL AND execution_mode='active' AND execution_transition_id IS NULL
          AND execution_intent_id IS NOT NULL AND execution_initiator_user_id IS NOT NULL AND execution_intent_authority IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM cloud_worker_runtime_handoffs h WHERE h.workspace_id=w.id AND h.state IN ('prepared','committed','activating','rolling_back'))
          AND ${CLOUD_V2_LIVE_ACCESS}`, [route.workspace.id, route.workspace.boatSandboxId, route.bootId, route.workerTokenHash,
        route.url, JSON.stringify(route.portToken), route.accessEpoch])).rows[0];
      if (!row) return null;
      if (row.recovery_attempt_id) return this.current(tx, row.recovery_attempt_id);
      if ((await tx.query(`SELECT 1 FROM cloud_v2_recovery_attempts WHERE workspace_id=$1
        AND created_at>clock_timestamp()-$2*interval '1 millisecond' LIMIT 1`, [route.workspace.id, RECOVERY_COOLDOWN_MS])).rowCount) return null;
      const attempt = (await tx.query<RecoveryAttempt>(`INSERT INTO cloud_v2_recovery_attempts(id,workspace_id,org_id,phase,
        source_sandbox_id,source_boot_id,source_token_hash,source_runtime_sha256,source_route_url,source_port_token,
        access_epoch,stop_generation,initiator_user_id,execution_intent_id,authority,deadline_at)
        SELECT $2,w.id,w.org_id,'waiting',w.boat_sandbox_id,w.worker_boot_id,w.worker_token_hash,w.worker_runtime_sha256,w.worker_route_url,w.worker_port_token,
          w.access_epoch,w.stop_generation,w.execution_initiator_user_id,w.execution_intent_id,w.execution_intent_authority,
          clock_timestamp()+$3*interval '1 millisecond' FROM cloud_v2_workspaces w WHERE w.id=$1 RETURNING *`,
      [route.workspace.id, randomUUID(), RECOVERY_DEADLINE_MS])).rows[0]!;
      await tx.query("UPDATE cloud_v2_workspaces SET recovery_attempt_id=$2,error_code=NULL WHERE id=$1", [route.workspace.id, attempt.id]);
      return attempt;
    });
  }

  private async lock(tx: Tx, id: string): Promise<RecoveryAttempt | null> {
    await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=(SELECT workspace_id FROM cloud_v2_recovery_attempts WHERE id=$1) FOR UPDATE", [id]);
    return (await tx.query<RecoveryAttempt>("SELECT * FROM cloud_v2_recovery_attempts WHERE id=$1 FOR UPDATE", [id])).rows[0] ?? null;
  }
  private async current(tx: Tx, id: string): Promise<RecoveryAttempt | null> {
    return (await tx.query<RecoveryAttempt>(`SELECT a.* FROM cloud_v2_recovery_attempts a JOIN cloud_v2_workspaces w ON w.id=a.workspace_id
      WHERE a.id=$1 AND a.phase IN ${ACTIVE} AND ${BINDING}`, [id])).rows[0] ?? null;
  }
  async read(id: string): Promise<RecoveryAttempt | null> {
    return withSystemTx(this.pool, async tx => (await tx.query<RecoveryAttempt>("SELECT * FROM cloud_v2_recovery_attempts WHERE id=$1", [id])).rows[0] ?? null);
  }
  async workspace(id: string, lease?: string, leaseMs = 0): Promise<CloudV2LifecycleWorkspace | null> {
    return withSystemTx(this.pool, async tx => {
      const row = (await (lease ? tx.query<WorkspaceRow>(`UPDATE cloud_v2_recovery_attempts a
        SET lease_until=least(a.deadline_at,clock_timestamp()+$3*interval '1 millisecond') FROM cloud_v2_workspaces w
        WHERE a.id=$1 AND a.lease_id=$2 AND a.lease_until>clock_timestamp() AND a.deadline_at>clock_timestamp()
          AND a.phase IN ${ACTIVE} AND ${BINDING} RETURNING w.*`, [id, lease, leaseMs])
        : tx.query<WorkspaceRow>(`SELECT w.* FROM cloud_v2_recovery_attempts a JOIN cloud_v2_workspaces w ON w.id=a.workspace_id
        WHERE a.id=$1 AND a.phase IN ${ACTIVE} AND a.deadline_at>clock_timestamp() AND ${BINDING}`, [id]))).rows[0];
      return row ? { ...cloudV2LifecycleWorkspaceFromRow(row), recoveryAttemptId: id } : null;
    });
  }
  async due(limit = 4): Promise<{ id: string; delay: number }[]> {
    return withSystemTx(this.pool, async tx => (await tx.query<{ id: string; delay: number }>(`SELECT id,
      greatest(0,extract(epoch FROM (greatest(next_attempt_at,coalesce(lease_until,'-infinity'))-clock_timestamp()))*1000)::float8 AS delay
      FROM cloud_v2_recovery_attempts WHERE phase IN ${ACTIVE}
        OR (phase IN ('succeeded','failed','cancelled') AND next_attempt_at<'infinity')
      ORDER BY greatest(next_attempt_at,coalesce(lease_until,'-infinity')),id LIMIT $1`, [limit])).rows);
  }
  async claim(id: string, leaseMs: number): Promise<RecoveryAttempt | null> {
    return withSystemTx(this.pool, async tx => {
      const a = await this.lock(tx, id); if (!a) return null;
      return (await tx.query<RecoveryAttempt>(`UPDATE cloud_v2_recovery_attempts SET lease_id=$2,
        lease_until=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1 AND next_attempt_at<=clock_timestamp()
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING *`, [id, randomUUID(), leaseMs])).rows[0] ?? null;
    });
  }
  async defer(id: string, lease: string, ms: number | null): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(`UPDATE cloud_v2_recovery_attempts SET lease_id=NULL,lease_until=NULL,
      next_attempt_at=CASE WHEN $3::double precision IS NULL THEN 'infinity'::timestamptz ELSE clock_timestamp()+$3*interval '1 millisecond' END
      WHERE id=$1 AND lease_id=$2`, [id, lease, ms]));
  }

  private async quiet(tx: Tx, id: string, afterFence: boolean): Promise<boolean> {
    return !(await tx.query(`SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1
        AND state IN ('queued','inboxed','dispatching','accepted') AND (NOT $2::boolean OR state<>'queued' OR delivery_id IS NOT NULL)
      UNION ALL SELECT 1 FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='turn' AND state='active'
      UNION ALL SELECT 1 FROM cloud_v2_prompt_chats WHERE workspace_id=$1 AND stop_acked_epoch<epoch
      UNION ALL SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND setup_status->>'state'='running' LIMIT 1`, [id, afterFence])).rowCount;
  }
  async fence(id: string): Promise<boolean> {
    return withSystemTx(this.pool, async tx => {
      await this.lock(tx, id); const a = await this.current(tx, id);
      if (!a || a.phase !== "waiting" || !await this.quiet(tx, a.workspace_id, false)) return false;
      const changed = await tx.query(`UPDATE cloud_v2_recovery_attempts SET phase='sealing',updated_at=clock_timestamp(),next_attempt_at=clock_timestamp()
        WHERE id=$1 AND deadline_at>clock_timestamp()`, [id]);
      if (changed.rowCount) await tx.query("SELECT pg_notify('zeros_cloud_v2_prompts',$1)", [a.workspace_id]);
      return changed.rowCount === 1;
    });
  }
  async canFence(id: string): Promise<boolean> {
    return withSystemTx(this.pool, async tx => {
      const a = await this.current(tx, id);
      return !!a && a.phase === "waiting" && await this.quiet(tx, a.workspace_id, false);
    });
  }
  async pull(token: string, boot: string, id: string): Promise<{ hold: boolean; hint?: { id: string } }> {
    return withSystemTx(this.pool, async tx => {
      const a = await this.current(tx, id); if (!a) throw changed();
      const source = a.source_boot_id === boot && a.source_token_hash.equals(hashCloudV2Token(token));
      const candidate = a.replacement_boot_id === boot && a.replacement_token_hash?.equals(hashCloudV2Token(token));
      if (!source && !candidate) throw changed();
      if (candidate) return { hold: a.setup_succeeded_at === null || a.worker_ready_at === null };
      return a.phase === "waiting" ? { hold: false } : { hold: true, hint: { id } };
    });
  }
  async request(token: string, boot: string, input: CloudRecoveryRequest): Promise<CloudRecoveryReply> {
    return withSystemTx(this.pool, async tx => {
      let a = await this.lock(tx, input.id);
      if (!a || a.source_boot_id !== boot || !a.source_token_hash.equals(hashCloudV2Token(token)) ||
        (a.worker_generation !== null && Number(a.worker_generation) !== input.generation)) throw changed();
      if (a.phase === "cancelled") return { id: a.id, generation: input.generation, status: "cancelled" };
      if (a.worker_generation !== null && a.sealed_at) return { id: a.id, generation: input.generation, status: "sealed" };
      if ((input.op !== "seal" && a.worker_generation === null) || a.phase !== "sealing" || !await this.current(tx, a.id)) throw changed();
      const quiet = await this.quiet(tx, a.workspace_id, true);
      a = (await tx.query<RecoveryAttempt>(`UPDATE cloud_v2_recovery_attempts SET worker_generation=$2,
        phase=CASE WHEN $3 THEN 'sealed' ELSE phase END,sealed_at=CASE WHEN $3 THEN clock_timestamp() ELSE sealed_at END,
        updated_at=CASE WHEN $3 THEN clock_timestamp() ELSE updated_at END,next_attempt_at=clock_timestamp()
        WHERE id=$1 AND deadline_at>clock_timestamp() RETURNING *`,
      [a.id, input.generation, quiet])).rows[0] ?? null;
      if (!a) throw changed();
      if (quiet) await tx.query("UPDATE cloud_v2_workspaces SET state='starting',updated_at=clock_timestamp(),next_attempt_at=$2 WHERE id=$1", [a.workspace_id, a.deadline_at]);
      return { id: a.id, generation: input.generation, status: quiet ? "sealed" : "pending" };
    });
  }

  async cancel(id: string, route?: WorkerRoute): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      const a = await this.lock(tx, id); if (!a || a.phase === "cancelled") return;
      if (route && (a.published_at || a.source_sandbox_id !== route.workspace.boatSandboxId || a.source_boot_id !== route.bootId ||
        a.source_token_hash.toString("hex") !== route.workerTokenHash || a.access_epoch !== route.accessEpoch ||
        a.source_route_url !== route.url || !["waiting", "sealing", "sealed"].includes(a.phase) || !await this.current(tx, id))) return;
      if (!["waiting", "sealing", "sealed"].includes(a.phase) || a.source_stopped_at || a.checkpoint_object)
        throw new HttpError(409, "recovery_capture_pending", "Recovery shutdown must be reconciled before cancellation.");
      await tx.query("UPDATE cloud_v2_recovery_attempts SET phase='cancelled',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [id]);
      await tx.query("UPDATE cloud_v2_workspaces SET recovery_attempt_id=NULL,state='running',error_code=NULL,next_attempt_at=NULL WHERE id=$1 AND recovery_attempt_id=$2", [a.workspace_id, id]);
    });
  }
  async fail(id: string, code: string, lease?: string): Promise<void> {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(code)) throw new Error("Invalid recovery reason");
    await withSystemTx(this.pool, async tx => {
      const a = await this.lock(tx, id); if (!a || a.completed_at || lease && a.lease_id !== lease) return;
      const current = await this.current(tx, id);
      const safe = ["waiting", "sealing", "sealed"].includes(a.phase) && !a.checkpoint_object && !a.source_stopped_at;
      await tx.query(`UPDATE cloud_v2_recovery_attempts SET phase=$2,first_error_code=coalesce(first_error_code,$3),
        completed_at=clock_timestamp(),updated_at=clock_timestamp(),next_attempt_at=clock_timestamp() WHERE id=$1`, [id, safe ? "cancelled" : "failed", code]);
      if (!current) return;
      await tx.query(`UPDATE cloud_v2_workspaces SET recovery_attempt_id=NULL,state=$3,error_code='live_connection_unavailable',next_attempt_at=NULL,
        boat_sandbox_id=$4,worker_boot_id=$5,worker_token_hash=$6,worker_route_url=$7,worker_port_token=$8,
        restore_pending=false,execution_restore_claimed_at=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND recovery_attempt_id=$2 AND stop_generation=$9`,
      [a.workspace_id, id, safe ? "running" : "failed", a.source_sandbox_id, a.source_boot_id, a.source_token_hash,
        a.source_route_url, a.source_port_token, a.stop_generation]);
    });
  }

  private async mutate(id: string, lease: string, phases: RecoveryPhase[], run: (tx: Tx, a: RecoveryAttempt) => Promise<void>): Promise<boolean> {
    return withSystemTx(this.pool, async tx => {
      await this.lock(tx, id); const a = await this.current(tx, id);
      if (!a || a.lease_id !== lease || !phases.includes(a.phase)) return false;
      if (!(await tx.query("SELECT 1 FROM cloud_v2_recovery_attempts WHERE id=$1 AND lease_until>clock_timestamp() AND deadline_at>clock_timestamp()", [id])).rowCount) return false;
      await run(tx, a); return true;
    });
  }
  async startCapture(id: string, lease: string): Promise<boolean> {
    return this.mutate(id, lease, ["sealed"], async tx => {
      await tx.query("UPDATE cloud_v2_recovery_attempts SET phase='capturing',updated_at=clock_timestamp() WHERE id=$1", [id]);
    });
  }
  async stopped(id: string, lease: string): Promise<boolean> {
    return this.mutate(id, lease, ["capturing"], async tx => {
      await tx.query("UPDATE cloud_v2_recovery_attempts SET source_stopped_at=coalesce(source_stopped_at,clock_timestamp()) WHERE id=$1", [id]);
    });
  }
  async upload(id: string, lease: string, input: { object: string; key: unknown; until: Date }): Promise<boolean> {
    return this.mutate(id, lease, ["capturing"], async (tx, a) => {
      if (!a.source_stopped_at || a.checkpoint_object) throw changed();
      await tx.query("UPDATE cloud_v2_recovery_attempts SET checkpoint_object=$2,checkpoint_key=$3,checkpoint_upload_until=$4 WHERE id=$1", [id, input.object, JSON.stringify(input.key), input.until]);
      await tx.query(`UPDATE cloud_v2_workspaces SET checkpoint_uploads=checkpoint_uploads||jsonb_build_object($2::text,$3::timestamptz)
        WHERE id=$1`, [a.workspace_id, input.object, input.until]);
    });
  }
  async captured(id: string, lease: string, input: { object: string; sha256: string; bytes: number }): Promise<boolean> {
    return this.mutate(id, lease, ["capturing"], async (tx, a) => {
      if (a.checkpoint_object !== input.object || !a.source_stopped_at) throw changed();
      await tx.query(`UPDATE cloud_v2_recovery_attempts SET checkpoint_sha256=$2,checkpoint_bytes=$3,checkpoint_saved_at=clock_timestamp(),
        checkpoint_upload_until=NULL,phase='restoring',updated_at=clock_timestamp() WHERE id=$1`, [id, input.sha256, input.bytes]);
      await tx.query("UPDATE cloud_v2_workspaces SET checkpoint_uploads=checkpoint_uploads-$2 WHERE id=$1", [a.workspace_id, input.object]);
    });
  }
  async prepare(id: string, lease: string, input: { name: string; env: Record<string, string>; runtime: string; tokenHash: Buffer; token: unknown }): Promise<boolean> {
    return this.mutate(id, lease, ["restoring"], async (tx, a) => {
      if (a.replacement_create) return;
      const w = (await tx.query<WorkspaceRow>("SELECT * FROM cloud_v2_workspaces WHERE id=$1", [a.workspace_id])).rows[0]!;
      const build = (await tx.query<{ id: string; snapshot_name: string; source_policy_version: number; recipe: unknown }>(`SELECT b.id,c.snapshot_name,b.source_policy_version,b.recipe
        FROM cloud_v2_computers c JOIN cloud_v2_computer_builds b ON b.id=c.active_build_id AND b.org_id=c.org_id
        WHERE c.org_id=$1 AND c.snapshot_name IS NOT NULL AND b.state='succeeded' AND b.source_policy_version IN (2,3)
          AND b.snapshot_id=c.snapshot_name AND b.snapshot_deleted_at IS NULL AND b.cleanup_requested_at IS NULL FOR SHARE OF c,b`, [w.org_id])).rows[0];
      if (!build) throw new HttpError(409, "cloud_computer_build_required", "A Cloud Computer is required for recovery.");
      const image = cloudV2WorkspaceImage({ policy: build.source_policy_version, snapshot: build.snapshot_name, recipe: build.recipe,
        scope: w.source_repositories, repository: w.repository });
      const create = { from: image.from, prune: image.prune, computerBuildId: build.id, name: input.name, env: input.env,
        ...(w.checkpoint_object ? { priorCheckpointObject: w.checkpoint_object } : {}),
        ...originalSetupBuild(w.computer_build_id, w.restore_create) };
      await tx.query(`UPDATE cloud_v2_recovery_attempts SET replacement_create=$2::jsonb||jsonb_build_object('requestedAt',clock_timestamp()),
        replacement_runtime_sha256=$3,replacement_token_hash=$4,replacement_token=$5 WHERE id=$1`,
      [id, JSON.stringify(create), input.runtime, input.tokenHash, JSON.stringify(input.token)]);
    });
  }
  async creating(id: string, lease: string): Promise<boolean> {
    return this.mutate(id, lease, ["restoring"], async (tx, a) => {
      if (!a.replacement_create || a.replacement_create.createRejectedAt) throw changed();
      await tx.query(`UPDATE cloud_v2_recovery_attempts SET replacement_create=replacement_create||
        jsonb_build_object('createIssuedAt',coalesce(replacement_create->>'createIssuedAt',clock_timestamp()::text)) WHERE id=$1`, [id]);
    });
  }
  async createRejected(id: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(`UPDATE cloud_v2_recovery_attempts SET replacement_create=replacement_create||
      jsonb_build_object('createRejectedAt',clock_timestamp()) WHERE id=$1 AND replacement_create IS NOT NULL AND replacement_sandbox_id IS NULL`, [id]));
  }
  async created(id: string, sandbox: string): Promise<void> {
    // A late create must remain findable even after Stop/Delete won.
    await withSystemTx(this.pool, tx => tx.query(`UPDATE cloud_v2_recovery_attempts SET replacement_sandbox_id=$2
      WHERE id=$1 AND replacement_create IS NOT NULL AND (replacement_sandbox_id IS NULL OR replacement_sandbox_id=$2)`, [id, sandbox]));
  }
  async claimRestore(id: string, lease: string): Promise<boolean> {
    let claimed = false;
    await this.mutate(id, lease, ["restoring"], async (tx, a) => {
      if (!a.replacement_sandbox_id || !a.replacement_create || a.replacement_create.restoreClaimedAt) return;
      await tx.query(`UPDATE cloud_v2_recovery_attempts SET replacement_create=replacement_create||jsonb_build_object('restoreClaimedAt',clock_timestamp()) WHERE id=$1`, [id]);
      claimed = true;
    });
    return claimed;
  }
  async restored(id: string, lease: string): Promise<boolean> {
    return this.mutate(id, lease, ["restoring"], async (tx, a) => {
      if (!a.replacement_create?.restoreClaimedAt) throw changed();
      await tx.query("UPDATE cloud_v2_recovery_attempts SET disk_verified_at=clock_timestamp(),phase='booting',updated_at=clock_timestamp() WHERE id=$1", [id]);
    });
  }
  async publish(id: string, lease: string, route: { url: string; token: unknown }): Promise<boolean> {
    return this.mutate(id, lease, ["booting"], async (tx, a) => {
      if (a.published_at) return;
      await tx.query(`UPDATE cloud_v2_recovery_attempts SET replacement_route_url=$2,replacement_port_token=$3,published_at=clock_timestamp() WHERE id=$1`, [id, route.url, JSON.stringify(route.token)]);
      await tx.query(`UPDATE cloud_v2_workspaces SET boat_sandbox_id=$3,worker_token_hash=$4,worker_boot_id=NULL,worker_recovery_boot_id=NULL,
        worker_route_url=$5,worker_port_token=$6,worker_runtime_sha256=$7,worker_runtime_boot_id=NULL,setup_status=NULL,
        computer_build_id=$8,restore_create=$9,restore_attempt=$2,restore_pending=false,execution_restore_claimed_at=NULL,
        checkpoint_object=$10,checkpoint_key=$11,checkpoint_sha256=$12,checkpoint_bytes=$13,checkpoint_saved_at=$14,
        checkpoint_stop_generation=stop_generation,checkpoint_reuse=NULL,lease_renewed_at=clock_timestamp(),state='starting',updated_at=clock_timestamp(),next_attempt_at=$15
        WHERE id=$1 AND recovery_attempt_id=$2`, [a.workspace_id, id, a.replacement_sandbox_id, a.replacement_token_hash,
        route.url, JSON.stringify(route.token), a.replacement_runtime_sha256, a.replacement_create!.computerBuildId, JSON.stringify(a.replacement_create),
        a.checkpoint_object, JSON.stringify(a.checkpoint_key), a.checkpoint_sha256, a.checkpoint_bytes, a.checkpoint_saved_at, a.deadline_at]);
    });
  }
  async delivered(id: string, lease: string): Promise<boolean> {
    let claimed = false;
    await this.mutate(id, lease, ["booting"], async (tx, a) => {
      if (!a.published_at || !a.replacement_create || a.replacement_create.bootDeliveredAt || a.replacement_boot_id) return;
      await tx.query(`UPDATE cloud_v2_recovery_attempts SET replacement_create=replacement_create||jsonb_build_object('bootDeliveredAt',clock_timestamp()) WHERE id=$1`, [id]);
      claimed = true;
    });
    return claimed;
  }
  async hello(token: string, boot: string, runtime: string, capable: boolean, id: string): Promise<boolean> {
    return withSystemTx(this.pool, async tx => {
      await this.lock(tx, id); const a = await this.current(tx, id); if (!a || !capable) return false;
      const hash = hashCloudV2Token(token);
      if (!a.published_at) return a.source_boot_id === boot && a.source_token_hash.equals(hash) && a.source_runtime_sha256 === runtime;
      if (!a.replacement_token_hash?.equals(hash) || a.replacement_runtime_sha256 !== runtime ||
        (a.replacement_boot_id && a.replacement_boot_id !== boot) || !["booting", "verifying"].includes(a.phase)) return false;
      return (await tx.query(`UPDATE cloud_v2_recovery_attempts SET replacement_boot_id=$2,phase='verifying',updated_at=clock_timestamp(),next_attempt_at=clock_timestamp()
        WHERE id=$1 AND deadline_at>clock_timestamp()`, [id, boot])).rowCount === 1;
    });
  }
  async setup(token: string, boot: string, id: string, report: CloudV2SetupStatus): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      await this.lock(tx, id); const a = await this.current(tx, id);
      if (a && !a.published_at && a.source_boot_id === boot && a.source_token_hash.equals(hashCloudV2Token(token))) return;
      if (!a || a.replacement_boot_id !== boot || !a.replacement_token_hash?.equals(hashCloudV2Token(token))) throw changed();
      if (report.state === "succeeded") await tx.query(`UPDATE cloud_v2_recovery_attempts SET setup_succeeded_at=coalesce(setup_succeeded_at,clock_timestamp()),
        next_attempt_at=clock_timestamp() WHERE id=$1`, [id]);
      else if (report.state !== "running") await tx.query(`UPDATE cloud_v2_recovery_attempts SET first_error_code=coalesce(first_error_code,'setup_failed'),next_attempt_at=clock_timestamp() WHERE id=$1`, [id]);
    });
  }
  async ready(id: string, lease: string, boot: string): Promise<boolean> {
    return this.mutate(id, lease, ["verifying"], async (tx, a) => {
      if (a.replacement_boot_id !== boot) throw changed();
      await tx.query("UPDATE cloud_v2_recovery_attempts SET worker_ready_at=coalesce(worker_ready_at,clock_timestamp()) WHERE id=$1", [id]);
    });
  }
  async succeed(id: string, lease: string): Promise<boolean> {
    let success = false;
    await this.mutate(id, lease, ["verifying"], async (tx, a) => {
      if (!a.worker_ready_at || !a.setup_succeeded_at || !a.disk_verified_at || a.first_error_code) return;
      await tx.query("UPDATE cloud_v2_recovery_attempts SET phase='succeeded',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [id]);
      await tx.query("UPDATE cloud_v2_workspaces SET recovery_attempt_id=NULL,state='running',error_code=NULL,next_attempt_at=NULL WHERE id=$1 AND recovery_attempt_id=$2", [a.workspace_id, id]);
      await tx.query("SELECT pg_notify('zeros_cloud_v2_prompts',$1)", [a.workspace_id]);
      await notifyCloudV2WorkerReady(tx, a.workspace_id);
      success = true;
    });
    return success;
  }

  async runtime(workspaceId: string): Promise<string | null> {
    return withSystemTx(this.pool, async tx => {
      const a = (await tx.query<Pick<RecoveryAttempt, "source_runtime_sha256" | "replacement_runtime_sha256" | "published_at">>(`
        SELECT a.source_runtime_sha256,a.replacement_runtime_sha256,a.published_at FROM cloud_v2_workspaces w
        JOIN cloud_v2_recovery_attempts a ON a.id=w.recovery_attempt_id WHERE w.id=$1 AND a.phase IN ${ACTIVE}`, [workspaceId])).rows[0];
      return a ? a.published_at ? a.replacement_runtime_sha256 : a.source_runtime_sha256 : null;
    });
  }

  async ownedSandbox(sandbox: string): Promise<boolean> {
    return withSystemTx(this.pool, async tx => !!(await tx.query(
      "SELECT 1 FROM cloud_v2_workspaces WHERE boat_sandbox_id=$1 AND state<>'deleted' LIMIT 1", [sandbox])).rowCount);
  }
  async sourceDisposable(id: string): Promise<boolean> {
    return withSystemTx(this.pool, async tx => !!(await tx.query(`SELECT 1 FROM cloud_v2_recovery_attempts a
      WHERE a.id=$1 AND (a.phase='succeeded' OR NOT EXISTS (
        SELECT 1 FROM cloud_v2_workspaces w WHERE w.id=a.workspace_id AND w.state NOT IN ('deleting','deleted')))`, [id])).rowCount);
  }
  async ownedCheckpoint(workspaceId: string, object: string): Promise<boolean> {
    return withSystemTx(this.pool, async tx => !!(await tx.query(
      "SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND checkpoint_object=$2 AND state<>'deleted'", [workspaceId, object])).rowCount);
  }
  async deletedSandbox(id: string, sandbox: string): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      await this.lock(tx, id);
      await tx.query(`UPDATE cloud_v2_recovery_attempts SET
        source_deleted_at=CASE WHEN source_sandbox_id=$2 THEN clock_timestamp() ELSE source_deleted_at END,
        replacement_deleted_at=CASE WHEN replacement_sandbox_id=$2 THEN clock_timestamp() ELSE replacement_deleted_at END
        WHERE id=$1 AND completed_at IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM cloud_v2_workspaces WHERE boat_sandbox_id=$2 AND state<>'deleted')`, [id, sandbox]);
    });
  }

  /** Cleanup receipts are never discarded merely because they became old. */
  async purge(id: string, lease: string, deletedObjects: readonly string[]): Promise<boolean> {
    return withSystemTx(this.pool, async tx => {
      const a = await this.lock(tx, id);
      if (!a?.completed_at || a.lease_id !== lease || Date.now() - a.completed_at.getTime() < RECOVERY_RETENTION_MS ||
        (a.checkpoint_upload_until && a.checkpoint_upload_until.getTime() > Date.now()) ||
        (a.replacement_create?.createIssuedAt && !a.replacement_sandbox_id && !a.replacement_create.createRejectedAt)) return false;
      for (const [sandbox, deleted] of [[a.source_sandbox_id, a.source_deleted_at], [a.replacement_sandbox_id, a.replacement_deleted_at]]) {
        if (sandbox && !deleted && !(await tx.query("SELECT 1 FROM cloud_v2_workspaces WHERE boat_sandbox_id=$1 AND state<>'deleted' LIMIT 1", [sandbox])).rowCount) return false;
      }
      for (const object of [a.checkpoint_object, a.replacement_create?.priorCheckpointObject]) {
        if (object && !deletedObjects.includes(object) && !(await tx.query(
          "SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND checkpoint_object=$2 AND state<>'deleted'", [a.workspace_id, object])).rowCount) return false;
      }
      if (deletedObjects.length) await tx.query("UPDATE cloud_v2_workspaces SET checkpoint_uploads=checkpoint_uploads-$2::text[] WHERE id=$1", [a.workspace_id, deletedObjects]);
      return (await tx.query("DELETE FROM cloud_v2_recovery_attempts WHERE id=$1 AND lease_id=$2", [id, lease])).rowCount === 1;
    });
  }
}
