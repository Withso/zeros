// Test-only compatibility fixture: claimIntent and recordFailure are frozen
// verbatim from c4895c03 (apart from public visibility and relative imports).
// The provider loop is shared with the current reconciler; neither the old
// claim nor the old failure handler knows about resume_after_intent_id.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { audit } from "../audit.js";
import { withSystemTx } from "../db.js";
import { CloudProviderError } from "./provider.js";
import { CloudWorkspaceReconciler, type CloudWorkspaceReconcilerOptions } from "./reconciler.js";
import {
  failCloudWorkspaceGenerationRollback,
  rollbackCloudWorkspaceGenerationTransition,
  rollbackCloudWorkspaceGenerationTransitionAfterDrainFailure,
} from "./generation-transitions.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";

type LifecycleOperation = "create" | "stop" | "wake" | "archive" | "delete";
type DesiredState = "running" | "stopped" | "archived" | "deleted";

type ClaimedIntent = {
  id: string;
  workspaceId: string;
  orgId: string;
  operation: LifecycleOperation;
  desiredState: DesiredState;
  generation: number;
  provider: string;
  imageRef: string;
  architecture: "linux/amd64" | "linux/arm64";
  cpuMillicores: number;
  memoryMiB: number;
  storageMiB: number;
  providerResourceId: string | null;
  attemptCount: number;
  affectsWorkspace: boolean;
  generationWasCurrent: boolean;
  generationTransitionId: string | null;
};

function desiredForOperation(operation: LifecycleOperation): DesiredState {
  switch (operation) {
    case "create":
    case "wake":
      return "running";
    case "stop":
      return "stopped";
    case "archive":
      return "archived";
    case "delete":
      return "deleted";
  }
}

function retryDelayMs(attempt: number, providerDelayMs?: number): number {
  const exponential = Math.min(
    5 * 60_000,
    1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 8),
  );
  const requested =
    typeof providerDelayMs === "number" && Number.isFinite(providerDelayMs)
      ? Math.min(5 * 60_000, Math.max(0, Math.ceil(providerDelayMs)))
      : 0;
  return Math.max(exponential, requested);
}

function safeFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number | undefined;
} {
  if (error instanceof CloudProviderError) {
    return {
      code: error.code.slice(0, 128),
      message: error.retryable
        ? "Cloud provider operation is temporarily unavailable"
        : "Cloud provider rejected the lifecycle operation",
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
    };
  }
  return {
    code: "provider_unknown_failure",
    message: "Cloud provider operation did not complete",
    retryable: true,
  };
}

class PreviousLifecycleWriter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly workerId: string,
    private readonly leaseMs: number,
  ) {}

  async claimIntent(): Promise<ClaimedIntent | null> {
    return withSystemTx(this.pool, async (tx) => {
      const result = await tx.query<{
        id: string;
        workspace_id: string;
        org_id: string;
        operation: LifecycleOperation;
        desired_state: DesiredState;
        current_generation: number;
        generation: number;
        provider: string;
        image_ref: string;
        architecture: "linux/amd64" | "linux/arm64";
        cpu_millicores: number;
        memory_mib: number;
        storage_mib: number;
        provider_resource_id: string | null;
        attempt_count: number;
        affects_workspace: boolean;
        generation_transition_id: string | null;
        checkpoint_request_id: string | null;
        checkpoint_request_state: string | null;
      }>(
        `SELECT i.id, i.workspace_id, i.org_id, i.operation,
                cw.desired_state, cw.current_generation, i.generation,
                i.affects_workspace, i.generation_transition_id, g.provider,
                g.image_ref, g.architecture, g.cpu_millicores,
                g.memory_mib, g.storage_mib, pb.provider_resource_id,
                i.attempt_count, checkpoint_request.id AS checkpoint_request_id,
                checkpoint_request.state AS checkpoint_request_state
         FROM cloud_workspace_lifecycle_intents i
         JOIN cloud_workspaces cw ON cw.id = i.workspace_id
         JOIN cloud_workspace_generations g
           ON g.workspace_id = i.workspace_id AND g.generation = i.generation
          AND g.org_id = i.org_id
         JOIN cloud_workspace_provider_bindings pb
           ON pb.workspace_id = g.workspace_id AND pb.generation = g.generation
         LEFT JOIN workspace_checkpoint_requests checkpoint_request
           ON checkpoint_request.lifecycle_intent_id = i.id
         WHERE i.next_attempt_at <= now()
           AND (
             i.state IN ('queued', 'observing')
             OR (i.state = 'dispatching' AND i.lease_expires_at <= now())
           )
           AND NOT EXISTS (
             SELECT 1 FROM cloud_workspace_lifecycle_intents active
             WHERE active.workspace_id = i.workspace_id
               AND active.id <> i.id
               AND active.state = 'dispatching'
               AND active.lease_expires_at > now()
           )
           AND (
             checkpoint_request.id IS NULL
             OR checkpoint_request.state = 'succeeded'
           )
           AND (
             i.operation <> 'create'
             OR NOT EXISTS (
               SELECT 1 FROM workspace_fork_intents fork
               WHERE fork.target_cloud_workspace_id = i.workspace_id
                 AND fork.org_id = i.org_id
                 AND fork.operation = 'local_to_cloud'
                 AND fork.state <> 'succeeded'
             )
           )
         ORDER BY i.created_at, i.id
         FOR UPDATE OF i, cw SKIP LOCKED
         LIMIT 1`,
      );
      const row = result.rows[0];
      if (!row) return null;

      let desiredState = row.desired_state;
      if (
        row.affects_workspace &&
        row.checkpoint_request_id !== null &&
        row.checkpoint_request_state === "succeeded" &&
        row.current_generation === row.generation &&
        row.desired_state === "running" &&
        ["stop", "archive", "delete"].includes(row.operation)
      ) {
        desiredState = desiredForOperation(row.operation);
        const status =
          row.operation === "stop"
            ? "stopping"
            : row.operation === "archive"
              ? "archiving"
              : "deleting";
        await tx.query(
          `UPDATE cloud_workspaces
           SET desired_state = $2, status = $3::cloud_workspace_status,
               authority_epoch = authority_epoch + 1,
               version = version + 1, updated_at = now(),
               last_error_code = NULL, last_error_message = NULL
           WHERE id = $1 AND current_generation = $4`,
          [row.workspace_id, desiredState, status, row.generation],
        );
        await retireCloudWorkspaceRuntimeAccess(tx, {
          workspaceId: row.workspace_id,
          organizationId: row.org_id,
          generation: row.generation,
          reason:
            row.operation === "stop"
              ? "workspace_stop_requested"
              : row.operation === "archive"
                ? "workspace_archive_requested"
                : "workspace_delete_requested",
        });
      }
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents
         SET state = 'dispatching', attempt_count = attempt_count + 1,
             lease_owner = $2,
             lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
             dispatched_at = coalesce(dispatched_at, now()), updated_at = now(),
             error_code = NULL, error_message = NULL
         WHERE id = $1`,
        [row.id, this.workerId, this.leaseMs],
      );
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        orgId: row.org_id,
        operation: row.operation,
        desiredState,
        generation: row.generation,
        provider: row.provider,
        imageRef: row.image_ref,
        architecture: row.architecture,
        cpuMillicores: row.cpu_millicores,
        memoryMiB: row.memory_mib,
        storageMiB: row.storage_mib,
        providerResourceId: row.provider_resource_id,
        attemptCount: row.attempt_count + 1,
        affectsWorkspace: row.affects_workspace,
        generationWasCurrent: row.generation === row.current_generation,
        generationTransitionId: row.generation_transition_id,
      };
    });
  }

  async recordFailure(
    intent: ClaimedIntent,
    error: unknown,
  ): Promise<void> {
    const failure = safeFailure(error);
    await withSystemTx(this.pool, async (tx) => {
      const current = await tx.query<{
        desired_state: DesiredState;
        current_generation: number;
      }>(
        `SELECT desired_state, current_generation
         FROM cloud_workspaces WHERE id = $1 FOR UPDATE`,
        [intent.workspaceId],
      );
      const workspace = current.rows[0];

      const owned = await tx.query<{
        state: string;
        lease_owner: string | null;
      }>(
        `SELECT state, lease_owner
         FROM cloud_workspace_lifecycle_intents
         WHERE id = $1 FOR UPDATE`,
        [intent.id],
      );
      const row = owned.rows[0];
      if (!row || row.lease_owner !== this.workerId) return;

      const superseded =
        !workspace ||
        (intent.affectsWorkspace &&
          (workspace.current_generation !== intent.generation ||
            workspace.desired_state !== desiredForOperation(intent.operation)));
      if (superseded) {
        await retireCloudWorkspaceRuntimeAccess(tx, {
          workspaceId: intent.workspaceId,
          organizationId: intent.orgId,
          generation: intent.generation,
          reason:
            workspace?.current_generation !== intent.generation
              ? "generation_superseded"
              : "lifecycle_superseded",
        });
        await tx.query(
          `UPDATE cloud_workspace_lifecycle_intents
           SET state = 'superseded', completed_at = now(), lease_owner = NULL,
               lease_expires_at = NULL, error_code = NULL,
               error_message = NULL, updated_at = now()
           WHERE id = $1`,
          [intent.id],
        );
        await audit(
          tx,
          intent.orgId,
          null,
          `cloud_workspace.${intent.operation}_superseded`,
          {
            workspaceId: intent.workspaceId,
            intentId: intent.id,
            generation: intent.generation,
            code: failure.code,
            staleGeneration:
              workspace?.current_generation !== intent.generation,
          },
        );
        return;
      }

      if (failure.retryable) {
        await tx.query(
          `UPDATE cloud_workspace_lifecycle_intents
           SET state = 'observing', lease_owner = NULL, lease_expires_at = NULL,
               next_attempt_at = now() + ($2::bigint * interval '1 millisecond'),
               error_code = $3, error_message = $4, updated_at = now()
           WHERE id = $1`,
          [
            intent.id,
            retryDelayMs(intent.attemptCount, failure.retryAfterMs),
            failure.code,
            failure.message,
          ],
        );
      } else {
        await tx.query(
          `UPDATE cloud_workspace_lifecycle_intents
           SET state = 'failed', completed_at = now(), lease_owner = NULL,
               lease_expires_at = NULL, error_code = $2,
               error_message = $3, updated_at = now()
           WHERE id = $1`,
          [intent.id, failure.code, failure.message],
        );
        const rolledBackFromDrain =
          !intent.affectsWorkspace &&
          intent.operation === "stop" &&
          intent.generationTransitionId
            ? await rollbackCloudWorkspaceGenerationTransitionAfterDrainFailure(
                tx,
                {
                  workspaceId: intent.workspaceId,
                  organizationId: intent.orgId,
                  sourceGeneration: intent.generation,
                  transitionId: intent.generationTransitionId,
                  errorCode: failure.code,
                  errorMessage: failure.message,
                },
              )
            : false;
        const rolledBack =
          rolledBackFromDrain ||
          (intent.affectsWorkspace && intent.operation === "create"
            ? await rollbackCloudWorkspaceGenerationTransition(tx, {
                workspaceId: intent.workspaceId,
                organizationId: intent.orgId,
                candidateGeneration: intent.generation,
                errorCode: failure.code,
                errorMessage: failure.message,
              })
            : false);
        if (intent.affectsWorkspace && !rolledBack) {
          await tx.query(
            `UPDATE cloud_workspaces
             SET status = 'failed', last_error_code = $2,
                 last_error_message = $3, updated_at = now(),
                 version = version + 1
             WHERE id = $1 AND current_generation = $4`,
            [
              intent.workspaceId,
              failure.code,
              failure.message,
              intent.generation,
            ],
          );
          await failCloudWorkspaceGenerationRollback(tx, {
            workspaceId: intent.workspaceId,
            organizationId: intent.orgId,
            sourceGeneration: intent.generation,
            errorCode: failure.code,
            errorMessage: failure.message,
          });
        }
        await retireCloudWorkspaceRuntimeAccess(tx, {
          workspaceId: intent.workspaceId,
          organizationId: intent.orgId,
          generation: intent.generation,
          reason: "provider_operation_failed",
        });
      }
      await audit(
        tx,
        intent.orgId,
        null,
        `cloud_workspace.${intent.operation}_${failure.retryable ? "retry_scheduled" : "failed"}`,
        {
          workspaceId: intent.workspaceId,
          intentId: intent.id,
          generation: intent.generation,
          code: failure.code,
          attempt: intent.attemptCount,
        },
      );
    });
  }

}

export function previousBackendReconciler(options: CloudWorkspaceReconcilerOptions): CloudWorkspaceReconciler {
  const workerId = options.workerId ?? randomUUID();
  const previous = new PreviousLifecycleWriter(options.pool, workerId, options.leaseMs ?? 30_000);
  const reconciler = new CloudWorkspaceReconciler({ ...options, workerId });
  Object.defineProperties(reconciler, {
    claimIntent: { value: previous.claimIntent.bind(previous) },
    recordFailure: { value: previous.recordFailure.bind(previous) },
  });
  return reconciler;
}
