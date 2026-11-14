import { createHash } from "node:crypto";
import { HttpError } from "../../authz.js";
import { withSystemTx, type Tx } from "../../db.js";
import { hashCloudV2Token } from "../tokens.js";
import type { CloudV2BootCleanRefusal } from "../contract.js";
import { actorBusy, actorChanged } from "./errors.js";
import type { CloudExecutionContexts, ExecutionWorker, ExecutionWorkspace } from "./store.js";
import { completeExecutionActivation } from "./activation.js";
import { failExecutionActivation } from "./activation-state.js";
import { completeExecutionCreation, failExecutionCreation } from "./creation.js";

type Boot = { boot_id: string; access_epoch: string; stop_generation: string; worker_token_hash: Buffer; replaced_by: string | null;
  retirement_id: string | null; retirement_hash: Buffer | null; retired_count: number | null; clean_at: Date | null;
  legacy_material: "none" | "removed" | "refused" | null; first_failed_at: Date | null };

export const CLEAN_EXECUTION_BOOT = `EXISTS(SELECT 1 FROM cloud_v2_execution_boots b WHERE b.workspace_id=w.id
  AND b.boot_id=w.worker_boot_id AND b.clean_at IS NOT NULL AND b.legacy_material IN ('none','removed')
  AND b.replaced_by IS NULL AND b.access_epoch=w.access_epoch AND b.stop_generation=w.stop_generation AND b.worker_token_hash=w.worker_token_hash)`;

export class CloudExecutionBoots {
  constructor(readonly contexts: CloudExecutionContexts) {}

  async bind(tx: Tx, identity: ExecutionWorker, previous: string | null) {
    const workspace = await this.contexts.worker(tx, identity, false, true);
    const existing = (await tx.query<Boot>("SELECT * FROM cloud_v2_execution_boots WHERE workspace_id=$1 AND boot_id=$2", [workspace.id, identity.bootId])).rows[0];
    if (existing && (previous !== identity.bootId || existing.replaced_by || existing.stop_generation !== workspace.stop_generation ||
      existing.access_epoch !== workspace.access_epoch || !existing.worker_token_hash.equals(workspace.worker_token_hash)))
      throw new HttpError(401, "worker_boot_changed", "A replaced worker boot cannot return");
    if (!existing) await tx.query(`INSERT INTO cloud_v2_execution_boots(workspace_id,org_id,boot_id,access_epoch,stop_generation,worker_token_hash)
      VALUES($1,$2,$3,$4,$5,$6)`, [workspace.id, workspace.org_id, identity.bootId, workspace.access_epoch, workspace.stop_generation, workspace.worker_token_hash]);
    await tx.query(`UPDATE cloud_v2_execution_boots SET replaced_by=$2 WHERE workspace_id=$1 AND boot_id<>$2 AND stop_generation=$3
      AND replaced_by IS DISTINCT FROM $2`, [workspace.id, identity.bootId, workspace.stop_generation]);
    const stale = (await tx.query<{ id: string }>(`SELECT id FROM cloud_v2_execution_contexts WHERE workspace_id=$1
      AND worker_boot_id<>$2 AND state='active' ORDER BY id`, [workspace.id, identity.bootId])).rows;
    for (const row of stale) await this.contexts.revoke(tx, row.id, "worker_changed");
    return workspace;
  }

  async assertClean(tx: Tx, workspace: Pick<ExecutionWorkspace, "id" | "worker_boot_id" | "access_epoch" | "stop_generation" | "worker_token_hash">) {
    if (!(await tx.query(`SELECT 1 FROM cloud_v2_workspaces w WHERE w.id=$1 AND w.worker_boot_id=$2
      AND w.access_epoch=$3 AND w.stop_generation=$4 AND w.worker_token_hash=$5 AND ${CLEAN_EXECUTION_BOOT}`,
    [workspace.id, workspace.worker_boot_id, workspace.access_epoch, workspace.stop_generation, workspace.worker_token_hash])).rowCount) throw actorBusy();
  }

  async clean(identity: ExecutionWorker, input: { retirementId: string; processes: number; legacyMaterial?: "none" | "removed" | "refused" | undefined;
    refusals?: CloudV2BootCleanRefusal[] | undefined }, logger?: Pick<Console, "warn">) {
    const legacyMaterial = input.legacyMaterial ?? "refused";
    const digest = createHash("sha256").update(JSON.stringify([input.retirementId, input.processes, legacyMaterial,
      ...(input.refusals ? [input.refusals] : [])])).digest();
    const result = await withSystemTx(this.contexts.pool, async tx => {
      const workspace = await this.contexts.worker(tx, identity, true, true);
      const boot = (await tx.query<Boot>("SELECT * FROM cloud_v2_execution_boots WHERE workspace_id=$1 AND boot_id=$2 FOR UPDATE", [workspace.id, identity.bootId])).rows[0];
      if (!boot || boot.replaced_by || boot.access_epoch !== workspace.access_epoch || boot.stop_generation !== workspace.stop_generation ||
        !boot.worker_token_hash.equals(hashCloudV2Token(identity.token)) || workspace.state === "stopping") throw actorChanged();
      if (boot.clean_at) {
        if (boot.retirement_id !== input.retirementId || !boot.retirement_hash?.equals(digest)) throw actorChanged();
        return { retired: boot.retired_count! };
      }
      if (input.processes || legacyMaterial === "refused") {
        await tx.query(`UPDATE cloud_v2_execution_boots SET last_processes=$3,first_failed_processes=coalesce(first_failed_processes,nullif($3,0)),
          first_failed_at=coalesce(first_failed_at,clock_timestamp()),legacy_material=$4,
          first_failed_legacy_material=coalesce(first_failed_legacy_material,$4),last_refusals=$5,
          first_failed_refusals=CASE WHEN first_failed_at IS NULL THEN $5::text[] ELSE first_failed_refusals END
          WHERE workspace_id=$1 AND boot_id=$2`,
        [workspace.id, identity.bootId, input.processes, legacyMaterial, input.refusals ?? null]);
        await failExecutionActivation(tx, workspace.id, "execution_not_retired", { legacyMaterial, refusals: input.refusals ?? null });
        await failExecutionCreation(tx, workspace);
        return { refused: true, firstFailure: boot.first_failed_at === null, workspaceId: workspace.id };
      }
      // Only the persisted replacement chain permits this boot to attest another
      // boot's cleanup. A changed token or Stop intent never supplies that proof.
      const retired = await tx.query<{ id: string }>(`UPDATE cloud_v2_execution_contexts c SET state='retired',reason=coalesce(reason,'worker_changed'),
        revoked_at=coalesce(revoked_at,clock_timestamp()),retired_at=clock_timestamp(),material=NULL,environment_version_id=NULL
        FROM cloud_v2_execution_boots b WHERE c.workspace_id=$1 AND c.worker_boot_id=b.boot_id AND b.workspace_id=c.workspace_id
          AND b.replaced_by=$2 AND b.stop_generation=$3 AND c.stop_generation=b.stop_generation AND c.worker_boot_id<>$2 AND c.state<>'retired'
        RETURNING c.id`, [workspace.id, identity.bootId, workspace.stop_generation]);
      const ids = retired.rows.map(row => row.id);
      await tx.query("DELETE FROM cloud_v2_execution_tokens WHERE context_id=ANY($1::uuid[])", [ids]);
      await tx.query(`UPDATE cloud_v2_prompt_outbox SET state='interrupted',terminal_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND execution_context_id=ANY($2::uuid[]) AND state IN ('dispatching','accepted')`, [workspace.id, ids]);
      await tx.query(`UPDATE cloud_v2_execution_boots SET retirement_id=$3,retirement_hash=$4,retired_count=$5,clean_at=clock_timestamp(),last_processes=0,legacy_material=$6,last_refusals=NULL
        WHERE workspace_id=$1 AND boot_id=$2`, [workspace.id, identity.bootId, input.retirementId, digest, ids.length, legacyMaterial]);
      if (ids.length) await tx.query("SELECT pg_notify('zeros_cloud_v2_prompts',$1)", [workspace.id]);
      await completeExecutionCreation(tx, workspace);
      await completeExecutionActivation(tx, workspace, legacyMaterial, this.contexts);
      return { retired: ids.length };
    });
    if ("refused" in result) {
      if (result.firstFailure) logger?.warn(`[cloud-v2] activation boot-clean refused classes=${input.refusals?.join(",") ?? "unreported"} workspace=${result.workspaceId.slice(0, 8)}`);
      throw new HttpError(409, "execution_not_retired", "Execution processes are still running or cleanup cannot be proved");
    }
    return result;
  }
}
