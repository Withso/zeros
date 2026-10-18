import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { withRetryableSystemTx } from "../db-retry.js";
import { audit } from "../audit.js";
import { cloudStopReason, diagnosticCode } from "./cloud-diagnostics.js";
import { findInitiatingCloudStopTx, tryRetainCloudDiagnosticTx } from "./cloud-diagnostic-store.js";
import { enqueueWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import { cancelCloudWorkspaceGenerationTransition } from "./generation-transitions.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";
import { recordCloudWorkspaceStopUnsealed } from "./stop-seal.js";

/** Budget expiry preserves the VM's recoverable snapshot. Give the engine a
 * final-checkpoint window while it is still funded; if that fails, retain the
 * last durable checkpoint and stop compute without declaring a new checkpoint
 * durable or permanently deleting the allocation. A checking worker may pass
 * its schedule token to acknowledge only the re-check this stop itself causes;
 * an earlier concurrent request is retained, and later requests still differ
 * from the returned token. */
export async function requestManagedComputeStop(
  pool: pg.Pool,
  input: {
    leaseId: string;
    reason: string;
    incidentId?: string;
    stopReason?: "provider_outage" | "control_plane_unavailable";
    force?: boolean;
    checkpointDeadlineMs?: number;
    expectedLeaseOwner?: string;
    expectedGeneration?: number;
    expectedNextCheckAt?: string;
  },
): Promise<string | undefined> {
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(input.reason))
    throw new Error("Invalid compute stop reason");
  return withRetryableSystemTx(pool, async (tx) => {
    const scope = (
      await tx.query<{
        workspace_id: string;
        org_id: string;
        generation: number;
      }>(
        "SELECT workspace_id,org_id,generation FROM managed_compute_allocation_leases WHERE id=$1",
        [input.leaseId],
      )
    ).rows[0];
    if (!scope) return;
    await tx.query("SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE", [
      scope.org_id,
    ]);
    let workspace = (
      await tx.query<{
        current_generation: number;
        desired_state: string;
        status: string;
      }>(
        "SELECT current_generation,desired_state,status FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE",
        [scope.workspace_id, scope.org_id],
      )
    ).rows[0];
    if (!workspace) return;
    scope.generation=(await tx.query<{generation:number}>(`SELECT coalesce((SELECT current_generation FROM cloud_workspace_allocation_owners
      WHERE allocation_lease_id=$1 AND workspace_id=$2 AND org_id=$3),$4) AS generation`,
    [input.leaseId,scope.workspace_id,scope.org_id,scope.generation])).rows[0]!.generation;
    if (input.expectedGeneration !== undefined && scope.generation !== input.expectedGeneration) return;
    const lease = (
      await tx.query<{ state: string; stop_intent_id: string | null; lease_owner: string | null; claim_live: boolean; check_current: boolean | null }>(
        "SELECT state,stop_intent_id,lease_owner,lease_expires_at>clock_timestamp() AS claim_live,next_check_at=$2::timestamptz AS check_current FROM managed_compute_allocation_leases WHERE id=$1 FOR UPDATE",
        [input.leaseId, input.expectedNextCheckAt ?? null],
      )
    ).rows[0];
    if (!lease || lease.state === "settled") return;
    // A late provider response must not cancel a lease another worker already
    // recovered. Check ownership while holding the same row lock as Stop.
    if (input.expectedLeaseOwner !== undefined &&
        (lease.lease_owner !== input.expectedLeaseOwner || !lease.claim_live)) return;
    const handledNextCheckAt = async (): Promise<string | undefined> => {
      if (!lease.check_current) return;
      // This transaction still owns the lease row. Only our own workspace
      // trigger can have changed its schedule since check_current was read.
      return (await tx.query<{ at: string }>(
        "SELECT next_check_at::text AS at FROM managed_compute_allocation_leases WHERE id=$1",
        [input.leaseId],
      )).rows[0]?.at;
    };
    await tx.query(
      "UPDATE managed_compute_allocation_leases SET state='draining',updated_at=now() WHERE id=$1",
      [input.leaseId],
    );
    if (workspace.desired_state === "deleted" || workspace.status === "deleted")
      return;
    if (workspace.current_generation === scope.generation) {
      await cancelCloudWorkspaceGenerationTransition(tx, {
        workspaceId: scope.workspace_id,
        organizationId: scope.org_id,
        reason: "workspace_stop_requested",
      });
      workspace = (
        await tx.query<{
          current_generation: number;
          desired_state: string;
          status: string;
        }>(
          "SELECT current_generation,desired_state,status FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE",
          [scope.workspace_id, scope.org_id],
        )
      ).rows[0]!;
    }
    const affectsWorkspace = workspace.current_generation === scope.generation;
    if (
      affectsWorkspace &&
      workspace.desired_state === "stopped" &&
      workspace.status === "stopped"
    )
      return;
    // Adopt the user's exact-generation stop as well as our own. A second
    // intent could cancel its in-flight capture and bypass the final seal.
    const pending = (await tx.query<{
      id: string; state: string; operation: "stop" | "archive"; requested_by: string | null; affects_workspace: boolean;
      checkpoint_id: string | null; checkpoint_state: string | null; checkpoint_live: boolean | null; checkpoint_error: string | null;
    }>(`SELECT intent.id,intent.state,intent.operation,intent.requested_by,intent.affects_workspace,request.id AS checkpoint_id,
        request.state AS checkpoint_state,request.error_code AS checkpoint_error,request.deadline_at>clock_timestamp() AS checkpoint_live
      FROM cloud_workspace_lifecycle_intents intent
      LEFT JOIN workspace_checkpoint_requests request ON request.lifecycle_intent_id=intent.id
      WHERE intent.workspace_id=$2 AND intent.org_id=$3 AND intent.generation=$4
        AND intent.operation IN ('stop','archive')
        AND (intent.id=$1 OR intent.affects_workspace)
        AND (intent.state IN ('queued','observing','dispatching') OR
          (intent.id=$1 AND intent.state IN ('failed','superseded') AND request.state IN ('expired','cancelled')
            AND request.error_code IN ('checkpoint_deadline_exceeded','workspace_active','superseded_by_newer_intent','mandatory_capture_cancelled')))
      ORDER BY (intent.id=$1) DESC NULLS LAST,intent.created_at DESC,intent.id LIMIT 1`,
    [lease.stop_intent_id, scope.workspace_id, scope.org_id, scope.generation])).rows[0];
    if (pending) await tx.query(
      "UPDATE managed_compute_allocation_leases SET stop_intent_id=$2,updated_at=now() WHERE id=$1",
      [input.leaseId, pending.id],
    );
    if (pending?.state === "superseded") {
      // Repair a cancellation written before mandatory drains were preserved.
      // Reuse its capture deadline instead of admitting another five minutes.
      await tx.query(`UPDATE cloud_workspace_lifecycle_intents SET state='queued',completed_at=NULL,
        lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1`, [pending.id]);
      await tx.query("UPDATE workspace_checkpoint_requests SET state=state WHERE id=$1 AND state='cancelled'", [pending.checkpoint_id]);
      pending.state = "queued";
    }
    if (
      pending &&
      ["queued", "observing", "dispatching"].includes(pending.state) &&
      (pending.state === "dispatching" ||
        pending.checkpoint_state === null ||
        pending.checkpoint_state === "succeeded" ||
        pending.checkpoint_error === "stop_unsealed" ||
        (!input.force && pending.checkpoint_live === true))
    )
      return;
    // An existing stop covers normal drain observations. Only a new stop or a
    // required escalation reaches evidence retention; reuse its initiating
    // cause when replacing the checkpoint with a direct safety stop.
    const initiating = await findInitiatingCloudStopTx(tx, {
      workspaceId:scope.workspace_id,organizationId:scope.org_id,generation:scope.generation,leaseId:input.leaseId,
      workspaceStopping:workspace.desired_state !== "running" || ["stopping","stopped","failed","archiving","archived"].includes(workspace.status),
    });
    const code = initiating ? diagnosticCode(initiating.code) : input.reason;
    const ordinaryStop = !initiating && (pending?.requested_by != null || input.reason === "workspace_stop_requested");
    const stopReason = initiating ? initiating.stopReason : input.stopReason;
    const incidentId = initiating?.id ?? input.incidentId ?? (ordinaryStop ? null : await tryRetainCloudDiagnosticTx(tx, {
      workspaceId: scope.workspace_id, organizationId: scope.org_id, generation: scope.generation,
      operationKind: "compute", operationId: input.leaseId, ...(input.expectedLeaseOwner ? { leaseOwner: input.expectedLeaseOwner } : {}),
    }, { phase: "authority_check", code: diagnosticCode(code), errorClass: "unknown", retryable: false,
      ...(stopReason ? { stopReason } : {}),
      decision: input.force ? "direct_stop" : "checkpoint", claim: "current" }));
    const reason = cloudStopReason(code, stopReason);
    if (!ordinaryStop) await tx.query("UPDATE managed_compute_allocation_leases SET last_error_code=$2 WHERE id=$1",[input.leaseId,code]);
    if (pending) {
      // The finite funding/provider limit can shorten the seal window, but it
      // cannot replace the operation or turn an incomplete capture into success.
      await tx.query(`UPDATE workspace_checkpoint_requests SET state='cancelled',completed_at=now(),error_code='stop_unsealed',
        deadline_at=least(deadline_at,greatest(clock_timestamp(),created_at+interval '1 millisecond'))
        WHERE id=$1 AND state IN ('queued','delivered','failed','expired','cancelled')`, [pending.checkpoint_id]);
      await tx.query(`UPDATE cloud_workspace_lifecycle_intents SET state='queued',completed_at=NULL,next_attempt_at=now(),
        lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1`, [pending.id]);
      await recordCloudWorkspaceStopUnsealed(tx, {
        workspaceId: scope.workspace_id, organizationId: scope.org_id, generation: scope.generation,
        intentId: pending.id, reason: "seal_deadline", checkpointRequestId: pending.checkpoint_id,
      });
      if (affectsWorkspace) {
        await retireCloudWorkspaceRuntimeAccess(tx, {
          workspaceId: scope.workspace_id, organizationId: scope.org_id, generation: scope.generation,
          reason: pending.operation === "stop" ? "workspace_stop_requested" : "workspace_archive_requested",
        });
        await tx.query(`UPDATE cloud_workspaces SET desired_state=$4::cloud_workspace_desired_state,status=$5::cloud_workspace_status,authority_epoch=authority_epoch+1,
          version=version+1,updated_at=now(),last_error_code=$2,last_error_message=$3 WHERE id=$1`,
        [scope.workspace_id, ordinaryStop ? null : code,
          ordinaryStop ? null : `${reason.message}${incidentId ? ` (incident ${incidentId})` : ''}`,
          pending.affects_workspace ? (pending.operation === "stop" ? "stopped" : "archived") : workspace.desired_state,
          pending.affects_workspace ? (pending.operation === "stop" ? "stopping" : "archiving")
            : workspace.desired_state === "running" ? "waking" : workspace.desired_state === "stopped" ? "stopping" : "archiving"]);
      }
      return handledNextCheckAt();
    }
    const key = `system:compute-stop:${randomUUID()}`;
    if (affectsWorkspace) {
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=now(),updated_at=now(),
        lease_owner=NULL,lease_expires_at=NULL,error_code=$2,error_message='Managed compute stop replaced this intent'
        WHERE workspace_id=$1 AND affects_workspace AND operation<>'delete' AND state IN ('queued','observing')`,
        [scope.workspace_id, code],
      );
      await tx.query(
        `UPDATE workspace_checkpoint_requests request SET state='cancelled',completed_at=now(),error_code=$2
        FROM cloud_workspace_lifecycle_intents intent WHERE request.lifecycle_intent_id=intent.id AND intent.workspace_id=$1
        AND intent.state='superseded' AND request.state IN ('queued','delivered')`,
        [scope.workspace_id, code],
      );
    }
    const intentId = randomUUID();
    await tx.query(
      `INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256,affects_workspace)
      VALUES ($1,$2,$3,$4,NULL,'stop',$5,$6,$7)`,
      [
        intentId,
        scope.workspace_id,
        scope.generation,
        scope.org_id,
        key,
        randomBytes(32),
        affectsWorkspace,
      ],
    );
    const checkpointPossible =
      affectsWorkspace &&
      !input.force &&
      ["ready", "busy"].includes(workspace.status) &&
      (
        await tx.query(
          `SELECT 1 FROM cloud_workspace_engine_instances engine WHERE workspace_id=$1 AND org_id=$2 AND generation=$3
        AND state='ready' AND lease_expires_at>now() AND cloud_workspace_compute_authority_live(workspace_id,generation) LIMIT 1`,
          [scope.workspace_id, scope.org_id, scope.generation],
        )
      ).rowCount !== 0;
    const checkpoint = checkpointPossible
      ? await enqueueWorkspaceCheckpointRequest(tx, {
          workspaceId: scope.workspace_id,
          organizationId: scope.org_id,
          generation: scope.generation,
          requestedBy: null,
          lifecycleIntentId: intentId,
          reason: "before_stop",
          idempotencyKey: `compute.${intentId}`,
          deadlineMs: input.checkpointDeadlineMs ?? 300000,
        })
      : null;
    if (affectsWorkspace && !checkpoint) {
      await recordCloudWorkspaceStopUnsealed(tx, {
        workspaceId: scope.workspace_id, organizationId: scope.org_id, generation: scope.generation,
        intentId, reason: input.force ? "seal_deadline" : "authority_closed", checkpointRequestId: null,
      });
      await retireCloudWorkspaceRuntimeAccess(tx, {
        workspaceId: scope.workspace_id,
        organizationId: scope.org_id,
        reason: "workspace_stop_requested",
      });
      await tx.query(
        `UPDATE cloud_workspaces SET desired_state='stopped',status='stopping',authority_epoch=authority_epoch+1,
        version=version+1,updated_at=now(),last_error_code=$2,last_error_message=$3 WHERE id=$1`,
        [scope.workspace_id, ordinaryStop ? null : code, ordinaryStop ? null : `${reason.message}${incidentId ? ` (incident ${incidentId})` : ''}`],
      );
    }
    await tx.query(
      "UPDATE managed_compute_allocation_leases SET stop_intent_id=$2,updated_at=now() WHERE id=$1",
      [input.leaseId, intentId],
    );
    await audit(
      tx,
      scope.org_id,
      null,
      "cloud_workspace.compute_stop_requested",
      {
        workspaceId: scope.workspace_id,
        generation: scope.generation,
        leaseId: input.leaseId,
        reason: code,
        stopReason: reason.code,
        incidentId,
        intentId,
        checkpointRequestId: checkpoint?.id ?? null,
        deadlineFallback: input.force === true,
      },
    );
    return handledNextCheckAt();
  });
}
