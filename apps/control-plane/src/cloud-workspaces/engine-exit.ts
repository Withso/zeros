import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { withSystemTx } from "../db.js";
import { admitUnavailableCloudEngineStopTx } from "./engine-health.js";

// Mirrors packages/protocol's cloud-runtime-lifecycle contract. The CP deploys
// independently; the supervisor/engine/CP parity suite checks all three wires.
export const CLOUD_ENGINE_EXIT_PATH = "/internal/v1/cloud-workspaces/engine/exited";
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const CloudEngineExitReportSchema = z.object({
  version: z.literal(1), audience: z.literal("zeros-cloud-engine-exit-v1"),
  reportId: uuid, reason: z.literal("unexpected_exit"),
  organizationId: uuid, workspaceId: uuid, generation: z.number().int().positive().max(2_147_483_647),
  engineInstanceId: uuid, setupRunId: uuid, executionFence: z.number().int().positive().safe(),
  runtimeId: z.string().regex(/^r1-[a-f0-9]{64}$/), bootId: uuid, supervisorSessionId: uuid,
}).strict();
export type CloudEngineExitInput = z.infer<typeof CloudEngineExitReportSchema> & { token: string };
export class CloudEngineExitRejected extends Error {
  constructor() { super("engine_exit_rejected"); }
}

/** The bridge secret can withdraw only its original engine, even after its
 * registration grant was consumed. Workspace locking orders withdrawal with
 * heartbeat, uplink renewal, capture completion and lifecycle admission. */
export async function reportCloudEngineExit(pool: pg.Pool, input: CloudEngineExitInput) {
  const { token, ...raw } = input;
  const parsed = CloudEngineExitReportSchema.safeParse(raw);
  if (!parsed.success || !/^zwb_[A-Za-z0-9_-]{43}$/.test(token)) throw new CloudEngineExitRejected();
  const report = parsed.data;
  return withSystemTx(pool, async tx => {
    await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [report.organizationId]);
    const workspace = (await tx.query<{ current_generation: number; status: string; desired_state: string; deleted_at: Date | null }>(
      "SELECT current_generation,status,desired_state,deleted_at FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE",
      [report.workspaceId, report.organizationId])).rows[0];
    // Do not lock the engine before runtime retirement's access/endpoint locks.
    const engine = (await tx.query<{ state: string; revoked_at: Date | null }>(`SELECT state,revoked_at
      FROM cloud_workspace_engine_instances engine WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4
        AND ((setup_run_id=$5 AND setup_execution_fence=$6) OR (setup_run_id IS NULL AND EXISTS (
          SELECT 1 FROM cloud_workspace_runtime_enrollments enrollment
          WHERE enrollment.id=engine.runtime_transition_enrollment_id AND enrollment.id=$5 AND enrollment.sequence=$6
            AND enrollment.engine_instance_id=engine.id AND enrollment.workspace_id=engine.workspace_id
            AND enrollment.org_id=engine.org_id AND enrollment.generation=engine.generation)))
        AND runtime_id=$7 AND runtime_boot_id=$8 AND runtime_supervisor_session_id=$9 AND bridge_token_hash=$10`,
    [report.engineInstanceId, report.workspaceId, report.organizationId, report.generation, report.setupRunId,
      report.executionFence, report.runtimeId, report.bootId, report.supervisorSessionId, createHash("sha256").update(token).digest()])).rows[0];
    if (!workspace || !engine) throw new CloudEngineExitRejected();
    const ack = { version: 1, audience: "zeros-cloud-engine-exit-v1", accepted: true,
      reportId: report.reportId, engineInstanceId: report.engineInstanceId };
    // An exact historical retry is acknowledged without touching its successor.
    if (engine.revoked_at || !["starting", "ready"].includes(engine.state)) return ack;
    const retireExact = () => tx.query(`UPDATE cloud_workspace_engine_instances
      SET state='revoked',revoked_at=coalesce(revoked_at,clock_timestamp()),updated_at=now() WHERE id=$1`, [report.engineInstanceId]);
    const scope = [report.workspaceId, report.organizationId, report.generation];
    const replacement = await tx.query(`SELECT 1 FROM cloud_workspace_engine_instances
      WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND id<>$4
        AND state IN ('starting','ready') AND revoked_at IS NULL LIMIT 1`, [...scope, report.engineInstanceId]);
    const runtimeTransition = await tx.query(`SELECT 1 FROM cloud_workspace_runtime_transitions
      WHERE workspace_id=$1 AND org_id=$2 AND phase NOT IN ('healthy','rolled_back','cancelled') LIMIT 1`, scope.slice(0, 2));
    const transition = (await tx.query<{ id: string; state: string; source_generation: number; candidate_generation: number; drain_intent_id: string }>(
      `SELECT id,state,source_generation,candidate_generation,drain_intent_id FROM cloud_workspace_generation_transitions
       WHERE workspace_id=$1 AND org_id=$2 AND state IN ('draining','provisioning','setting_up','rolling_back')`, scope.slice(0, 2))).rows[0];
    const pending = (await tx.query<{
      id: string; operation: "stop" | "archive" | "delete" | "create" | "wake"; state: string; attempt_count: number;
      request_id: string | null; request_state: string | null; request_reason: string | null;
    }>(`SELECT intent.id,intent.operation,intent.state,intent.attempt_count,request.id AS request_id,
        request.state AS request_state,request.reason AS request_reason
      FROM cloud_workspace_lifecycle_intents intent
      LEFT JOIN workspace_checkpoint_requests request ON request.lifecycle_intent_id=intent.id
        AND request.workspace_id=intent.workspace_id AND request.org_id=intent.org_id AND request.generation=intent.generation
      WHERE intent.workspace_id=$1 AND intent.org_id=$2 AND intent.generation=$3
        AND (intent.affects_workspace OR intent.id=$4) AND intent.state IN ('queued','dispatching','observing')
      ORDER BY intent.created_at,intent.id LIMIT 1`, [...scope, transition?.drain_intent_id ?? null])).rows[0];
    const uncommittedRebuild = transition?.state === "draining" && transition.source_generation === report.generation &&
      pending?.id === transition.drain_intent_id && pending.request_reason === "before_rebuild" &&
      pending.request_state !== "succeeded" && pending.attempt_count === 0;
    if (workspace.current_generation !== report.generation || workspace.deleted_at || engine.state !== "ready" ||
        replacement.rowCount || runtimeTransition.rowCount || (transition && !uncommittedRebuild) ||
        (pending && (pending.attempt_count > 0 || pending.state === "dispatching" || pending.request_state === "succeeded" ||
          (pending.operation === "delete" && pending.request_id === null))) ||
        (!pending && (workspace.desired_state !== "running" || !["ready", "busy"].includes(workspace.status)))) {
      await retireExact();
      return ack;
    }

    let adopted: { id: string; operation: "stop" | "archive" } | undefined;
    if (pending?.request_id && (pending.operation === "delete" || uncommittedRebuild)) {
      // Match the checkpoint deadline worker's pre-dispatch failure. An exit
      // cannot satisfy deletion/rebuild prerequisites or authorize a purge.
      await tx.query(`UPDATE workspace_checkpoint_requests SET state='failed',completed_at=now(),error_code='engine_exited'
        WHERE id=$1 AND state<>'succeeded'`, [pending.request_id]);
      await tx.query(`UPDATE cloud_workspace_lifecycle_intents SET state='failed',completed_at=now(),updated_at=now(),
        error_code='engine_exited',error_message='The engine exited before its final checkpoint completed',
        lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`, [pending.id]);
      if (uncommittedRebuild && transition) {
        await tx.query(`UPDATE cloud_workspace_generation_transitions SET state='cancelled',completed_at=now(),updated_at=now(),
          error_code='engine_exited',error_message='The engine exited before its final checkpoint completed' WHERE id=$1`, [transition.id]);
        await tx.query(`UPDATE cloud_workspace_generations SET retired_at=coalesce(retired_at,now())
          WHERE workspace_id=$1 AND org_id=$2 AND generation=$3`, [report.workspaceId, report.organizationId, transition.candidate_generation]);
      }
    } else if (pending && ["stop", "archive"].includes(pending.operation)) {
      adopted = { id: pending.id, operation: pending.operation as "stop" | "archive" };
      await tx.query(`UPDATE workspace_checkpoint_requests SET state='cancelled',completed_at=now(),error_code='stop_unsealed'
        WHERE id=$1 AND state<>'succeeded'`, [pending.request_id]);
      await tx.query(`UPDATE cloud_workspace_lifecycle_intents SET state='queued',next_attempt_at=now(),updated_at=now(),
        lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`, [pending.id]);
    } else if (pending) {
      // Setup/wake and transitions own their failure; never replace them.
      await retireExact();
      return ack;
    }
    await admitUnavailableCloudEngineStopTx(tx, {
      workspaceId: report.workspaceId, organizationId: report.organizationId, generation: report.generation,
      reason: "engine_exited", engineInstanceId: report.engineInstanceId,
      ...(adopted ? { adoptedIntent: adopted, checkpointRequestId: pending!.request_id } : {}),
    });
    return ack;
  });
}
