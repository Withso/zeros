import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx } from "../db.js";
import { audit } from "../audit.js";
import { enqueueWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import { cancelCloudWorkspaceGenerationTransition } from "./generation-transitions.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";

/** Budget expiry preserves the VM's recoverable snapshot. Give the engine a
 * final-checkpoint window while it is still funded; if that fails, retain the
 * last durable checkpoint and stop compute without declaring a new checkpoint
 * durable or permanently deleting the allocation. */
export async function requestManagedComputeStop(
  pool: pg.Pool,
  input: {
    leaseId: string;
    reason: string;
    force?: boolean;
    checkpointDeadlineMs?: number;
    expectedLeaseOwner?: string;
  },
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(input.reason))
    throw new Error("Invalid compute stop reason");
  await withSystemTx(pool, async (tx) => {
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
    const lease = (
      await tx.query<{ state: string; stop_intent_id: string | null; lease_owner: string | null; claim_live: boolean }>(
        "SELECT state,stop_intent_id,lease_owner,lease_expires_at>clock_timestamp() AS claim_live FROM managed_compute_allocation_leases WHERE id=$1 FOR UPDATE",
        [input.leaseId],
      )
    ).rows[0];
    if (!lease || lease.state === "settled") return;
    // A late provider response must not cancel a lease another worker already
    // recovered. Check ownership while holding the same row lock as Stop.
    if (input.expectedLeaseOwner !== undefined &&
        (lease.lease_owner !== input.expectedLeaseOwner || !lease.claim_live)) return;
    await tx.query(
      "UPDATE managed_compute_allocation_leases SET state='draining',last_error_code=$2,updated_at=now() WHERE id=$1",
      [input.leaseId, input.reason],
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
    // The durable lease owns idempotency. A public caller's key cannot reserve
    // a system operation's name, and superseding a stop cannot disable it.
    const pending = lease.stop_intent_id
      ? (
          await tx.query<{ state: string; checkpoint_state: string | null }>(
            `SELECT intent.state,request.state AS checkpoint_state
      FROM cloud_workspace_lifecycle_intents intent LEFT JOIN workspace_checkpoint_requests request ON request.lifecycle_intent_id=intent.id
      WHERE intent.id=$1 AND intent.workspace_id=$2 AND intent.org_id=$3`,
            [lease.stop_intent_id, scope.workspace_id, scope.org_id],
          )
        ).rows[0]
      : null;
    if (
      pending &&
      ["queued", "observing", "dispatching"].includes(pending.state) &&
      (!input.force ||
        pending.checkpoint_state === null ||
        pending.checkpoint_state === "succeeded")
    )
      return;
    const key = `system:compute-stop:${randomUUID()}`;
    if (affectsWorkspace) {
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=now(),updated_at=now(),
        lease_owner=NULL,lease_expires_at=NULL,error_code=$2,error_message='Managed compute stop replaced this intent'
        WHERE workspace_id=$1 AND affects_workspace AND operation<>'delete' AND state IN ('queued','observing')`,
        [scope.workspace_id, input.reason],
      );
      await tx.query(
        `UPDATE workspace_checkpoint_requests request SET state='cancelled',completed_at=now(),error_code=$2
        FROM cloud_workspace_lifecycle_intents intent WHERE request.lifecycle_intent_id=intent.id AND intent.workspace_id=$1
        AND intent.state='superseded' AND request.state IN ('queued','delivered')`,
        [scope.workspace_id, input.reason],
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
      await retireCloudWorkspaceRuntimeAccess(tx, {
        workspaceId: scope.workspace_id,
        organizationId: scope.org_id,
        reason: "workspace_stop_requested",
      });
      await tx.query(
        `UPDATE cloud_workspaces SET desired_state='stopped',status='stopping',authority_epoch=authority_epoch+1,
        version=version+1,updated_at=now(),last_error_code=$2,last_error_message='Managed compute stopped at its funded limit' WHERE id=$1`,
        [scope.workspace_id, input.reason],
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
        reason: input.reason,
        intentId,
        checkpointRequestId: checkpoint?.id ?? null,
        deadlineFallback: input.force === true,
      },
    );
  });
}
