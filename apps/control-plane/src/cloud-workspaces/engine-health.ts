import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { audit } from "../audit.js";
import { withSystemTx } from "../db.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";

/** Runtime authority already fails closed at lease expiry. Converge the
 * provider's compute too, including BYO. Never restart a dead engine, replay
 * its prompts, or overwrite live files with a checkpoint automatically. */
export async function stopUnavailableCloudEngine(
  pool: pg.Pool,
  provider: string | null,
): Promise<boolean> {
  return withSystemTx(pool, async (tx) => {
    const skipped: string[] = [];
    // Keep a bounded transaction while skipping contended workspaces. Take
    // organization locks first, in the same order as lifecycle admission.
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = (
        await tx.query<{ id: string; org_id: string }>(
          `
      SELECT workspace.id,workspace.org_id FROM cloud_workspaces workspace
      JOIN organizations organization ON organization.id=workspace.org_id
      JOIN cloud_workspace_generations generation ON generation.workspace_id=workspace.id
        AND generation.org_id=workspace.org_id AND generation.generation=workspace.current_generation
      WHERE ($1::text IS NULL OR generation.provider=$1) AND workspace.desired_state='running'
        AND NOT (workspace.id=ANY($2::uuid[]))
        AND workspace.status IN ('ready','busy') AND workspace.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM cloud_workspace_engine_instances engine
          WHERE engine.workspace_id=workspace.id AND engine.org_id=workspace.org_id
            AND engine.generation=workspace.current_generation AND engine.state='ready'
            AND engine.revoked_at IS NULL AND engine.lease_expires_at>clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents intent
          WHERE intent.workspace_id=workspace.id AND intent.org_id=workspace.org_id
            AND (intent.generation=workspace.current_generation OR intent.affects_workspace)
            AND intent.state IN ('queued','dispatching','observing'))
      ORDER BY workspace.updated_at,workspace.id
      FOR UPDATE OF organization SKIP LOCKED LIMIT 1`,
          [provider, skipped],
        )
      ).rows[0];
      if (!candidate) return false;
      skipped.push(candidate.id);
      // Match create/lifecycle lock order. Heartbeats also hold the workspace
      // lock, so a health decision cannot race a successful renewal.
      const workspace = (
        await tx.query<{ current_generation: number }>(
          `
      SELECT current_generation FROM cloud_workspaces WHERE id=$1 AND org_id=$2
        AND desired_state='running' AND status IN ('ready','busy') AND deleted_at IS NULL
      FOR UPDATE SKIP LOCKED`,
          [candidate.id, candidate.org_id],
        )
      ).rows[0];
      if (!workspace) continue;
      const live = await tx.query(
        `SELECT 1 FROM cloud_workspace_engine_instances
      WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND state='ready'
        AND revoked_at IS NULL AND lease_expires_at>clock_timestamp() LIMIT 1`,
        [candidate.id, candidate.org_id, workspace.current_generation],
      );
      if (live.rowCount) continue;
      const pending = await tx.query(
        `SELECT 1 FROM cloud_workspace_lifecycle_intents
      WHERE workspace_id=$1 AND org_id=$2 AND (generation=$3 OR affects_workspace)
        AND state IN ('queued','dispatching','observing') LIMIT 1`,
        [candidate.id, candidate.org_id, workspace.current_generation],
      );
      if (pending.rowCount) continue;

      const intentId = randomUUID();
      await retireCloudWorkspaceRuntimeAccess(tx, {
        workspaceId: candidate.id,
        organizationId: candidate.org_id,
        generation: workspace.current_generation,
        reason: "engine_unavailable",
      });
      await tx.query(
        `INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256,affects_workspace)
      VALUES($1,$2,$3,$4,NULL,'stop',$5,$6,true)`,
        [
          intentId,
          candidate.id,
          workspace.current_generation,
          candidate.org_id,
          `system:engine-stop:${randomUUID()}`,
          randomBytes(32),
        ],
      );
      await tx.query(
        `UPDATE cloud_workspaces SET desired_state='stopped',status='stopping',
      authority_epoch=authority_epoch+1,version=version+1,updated_at=now(),
      last_error_code='engine_unavailable',last_error_message='The engine lost its live lease; compute is stopping while durable recovery remains available'
      WHERE id=$1 AND org_id=$2`,
        [candidate.id, candidate.org_id],
      );
      await audit(
        tx,
        candidate.org_id,
        null,
        "cloud_workspace.engine_unavailable",
        {
          workspaceId: candidate.id,
          generation: workspace.current_generation,
          intentId,
          finalCheckpointSkipped: true,
          automaticReplay: false,
        },
      );
      return true;
    }
    return false;
  });
}
