import type pg from "pg";
import { audit } from "../audit.js";
import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx } from "../db.js";
import { createCloudWorkspaceGenerationReplacement } from "./routes.js";
import { CloudRuntimeError } from "./runtime-selection.js";

/** Called only for a stopped provider allocation and a standalone start intent.
 * Admission uses the existing replacement transaction; rollback uses the
 * existing generation transition. A rejected upgrade leaves ordinary resume
 * intact, including its original runtime authority checks. */
export async function upgradeCloudRuntimeOnWake(pool: pg.Pool, config: CloudWorkspaceBackendConfig,
  input: { workspaceId: string; organizationId: string; generation: number; intentId: string; workerId: string },
  workosEnabled: boolean): Promise<boolean> {
  return withSystemTx(pool, async tx => {
    await tx.query("SAVEPOINT runtime_wake_upgrade");
    try {
      const actor = (await tx.query<{ actor_id: string }>(`SELECT coalesce(intent.requested_by,workspace.owner_user_id) AS actor_id
        FROM cloud_workspace_lifecycle_intents intent JOIN cloud_workspaces workspace ON workspace.id=intent.workspace_id
        WHERE intent.id=$1 AND intent.workspace_id=$2 AND intent.org_id=$3`,
      [input.intentId,input.workspaceId,input.organizationId])).rows[0];
      if (!actor) {
        await tx.query("RELEASE SAVEPOINT runtime_wake_upgrade");
        return false;
      }
      const upgradeInput = { expectedGeneration: input.generation, operationId: input.intentId };
      const normalized = { operation: "runtime-upgrade", organizationId: input.organizationId, workspaceId: input.workspaceId, ...upgradeInput };
      await createCloudWorkspaceGenerationReplacement(config, { workosEnabled })(tx, {
        user: { id: actor.actor_id }, orgId: input.organizationId, workspaceId: input.workspaceId,
        key: `runtime-upgrade:automatic-wake:${input.intentId}`, upgradeInput, body: { operation: "upgrade" },
        normalize: () => normalized, automaticWake: { intentId: input.intentId, workerId: input.workerId },
      });
      // This is the durable receipt for the original wake, not a second start.
      // The replacement's drain/create intents now own execution.
      await tx.query(`UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',
        completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1`, [input.intentId]);
      await audit(tx,input.organizationId,null,"cloud_workspace.runtime_auto_upgrade_started",
        { workspaceId:input.workspaceId,sourceGeneration:input.generation,operationId:input.intentId });
      await tx.query("RELEASE SAVEPOINT runtime_wake_upgrade");
      return true;
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT runtime_wake_upgrade");
      await tx.query("RELEASE SAVEPOINT runtime_wake_upgrade");
      const code = error instanceof HttpError || error instanceof CloudRuntimeError ? error.code : "cloud_runtime_upgrade_deferred";
      if (code !== "cloud_runtime_already_current") await audit(tx,input.organizationId,null,"cloud_workspace.runtime_auto_upgrade_deferred",
        { workspaceId:input.workspaceId,generation:input.generation,code });
      return false;
    }
  });
}
